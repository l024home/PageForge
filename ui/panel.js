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

const store = {
  async get(key) {
    const data = await p(chrome.storage.local, "get", key);
    return data[key] || [];
  },
  async set(key, val) {
    await p(chrome.storage.local, "set", { [key]: val });
  }
};

let currentTabId = null;
let currentUrl = "";
let editingType = null;
let editingId = null;
let filters = { styles: "", scripts: "" };
let currentTheme = "dark";
let currentView = "card";
let pendingImportPayload = null;

const $ = id => document.getElementById(id);

// 图标表示“当前状态”
const ICON_CARD = '<path fill="currentColor" d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>';
const ICON_LIST = '<path fill="currentColor" d="M3 5h18v4H3V5zm0 6h18v4H3v-4zm0 6h18v4H3v-4z"/>';

(async () => {
  const [tab] = await p(chrome.tabs, "query", { active: true, currentWindow: true });
  currentTabId = tab?.id;
  currentUrl = tab?.url || "";
  $("siteLabel").textContent = "当前站点：" + (currentUrl ? new URL(currentUrl).hostname : "—");

  const prefs = await p(chrome.storage.local, "get", ["theme", "view"]);
  currentTheme = prefs.theme || "dark";
  currentView = prefs.view || "card";
  applyTheme(currentTheme);
  applyView(currentView);

  $("themeBtn").addEventListener("click", async () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    applyTheme(currentTheme);
    await p(chrome.storage.local, "set", { theme: currentTheme });
  });
  $("viewBtn").addEventListener("click", async () => {
    currentView = currentView === "card" ? "list" : "card";
    applyView(currentView);
    await p(chrome.storage.local, "set", { view: currentView });
  });

  $("exportBtn").addEventListener("click", () => $("exportDialog").showModal());
  $("closeExport").addEventListener("click", () => $("exportDialog").close());
  $("exportCancel").addEventListener("click", () => $("exportDialog").close());
  $("exportConfirm").addEventListener("click", exportRules);

  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", onImportFileChosen);
  $("closeImport").addEventListener("click", closeImportDialog);
  $("importCancel").addEventListener("click", closeImportDialog);
  $("importMerge").addEventListener("click", () => executeImport("merge"));
  $("importReplace").addEventListener("click", () => executeImport("replace"));

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(pnl => pnl.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  $("refreshBtn").addEventListener("click", () => {
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { type: "REFRESH" }, () => void chrome.runtime.lastError);
    }
  });

  $("styleSearch").addEventListener("input", e => {
    filters.styles = e.target.value.toLowerCase();
    renderList("styles", "styleList");
  });
  $("scriptSearch").addEventListener("input", e => {
    filters.scripts = e.target.value.toLowerCase();
    renderList("scripts", "scriptList");
  });

  const corsToggle = $("corsToggle");
  const corsOrigin = $("corsOrigin");
  const data = await p(chrome.storage.local, "get", ["corsEnabled", "corsTarget"]);
  corsToggle.checked = !!data.corsEnabled;
  corsOrigin.value = data.corsTarget || "http://localhost:3000";
  updateCorsStatus(corsToggle.checked);

  corsToggle.addEventListener("change", async () => {
    await p(chrome.storage.local, "set", { corsEnabled: corsToggle.checked });
    updateCorsStatus(corsToggle.checked);
    chrome.runtime.sendMessage({
      type: "SET_CORS",
      enabled: corsToggle.checked,
      origin: corsOrigin.value.trim() || "http://localhost:3000"
    }, () => void chrome.runtime.lastError);
  });
  corsOrigin.addEventListener("change", async () => {
    await p(chrome.storage.local, "set", { corsTarget: corsOrigin.value.trim() });
    if (corsToggle.checked) {
      chrome.runtime.sendMessage({
        type: "SET_CORS", enabled: true, origin: corsOrigin.value.trim()
      }, () => void chrome.runtime.lastError);
    }
  });
  $("copyOrigin").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(corsOrigin.value.trim());
      $("copyOrigin").textContent = "已复制";
      setTimeout(() => { $("copyOrigin").textContent = "复制"; }, 1200);
    } catch {}
  });

  $("addStyleBtn").addEventListener("click", () => openEditor("styles"));
  $("addScriptBtn").addEventListener("click", () => openEditor("scripts"));
  $("closeEditor").addEventListener("click", closeDialog);
  $("cancelItem").addEventListener("click", closeDialog);
  $("saveItem").addEventListener("click", saveItem);
  $("deleteItem").addEventListener("click", deleteItem);

  const codeEl = $("editCode");
  const highlightEl = $("codeHighlight");
  codeEl.addEventListener("input", () => {
    updateLineNumbers();
    updateHighlight();
  });
  codeEl.addEventListener("scroll", () => {
    $("lineNumbers").scrollTop = codeEl.scrollTop;
    highlightEl.scrollTop = codeEl.scrollTop;
    highlightEl.scrollLeft = codeEl.scrollLeft;
  });
  codeEl.addEventListener("keydown", e => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = codeEl.selectionStart;
      const end = codeEl.selectionEnd;
      codeEl.value = codeEl.value.slice(0, start) + "  " + codeEl.value.slice(end);
      codeEl.selectionStart = codeEl.selectionEnd = start + 2;
      updateLineNumbers();
      updateHighlight();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveItem();
    }
  });
  ["editName", "editPattern", "editCode"].forEach(id => {
    $(id).addEventListener("input", () => { $("dirtyIndicator").hidden = false; });
  });

  refreshAllLists();
})();

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function applyView(view) {
  document.body.dataset.view = view;
  const icon = $("viewIcon");
  if (icon) icon.innerHTML = view === "card" ? ICON_CARD : ICON_LIST;
  $("viewBtn").title = view === "card" ? "切换为列表展示" : "切换为卡片展示";
}

function updateCorsStatus(on) {
  const dot = $("corsStatus").querySelector(".dot");
  dot.className = "dot " + (on ? "on" : "off");
  $("corsStatusText").textContent = on ? "已启用（仅 localhost/127.0.0.1）" : "未启用";
}

async function refreshAllLists() {
  const [styles, scripts] = await Promise.all([store.get("styles"), store.get("scripts")]);
  const activeCount = [...styles, ...scripts].filter(i => i.enabled !== false).length;
  $("activeCount").textContent = activeCount + " 条生效";
  renderListFromData("styles", "styleList", styles);
  renderListFromData("scripts", "scriptList", scripts);
}

function renderList(type, containerId) {
  store.get(type).then(items => {
    renderListFromData(type, containerId, items);
  });
}

function renderListFromData(type, containerId, items) {
  const container = $(containerId);
  if (!container) return;
  const filter = filters[type] || "";
  const filtered = items.filter(item =>
    !filter ||
    (item.name || "").toLowerCase().includes(filter) ||
    (item.urlPattern || "").toLowerCase().includes(filter)
  );

  if (!filtered.length) {
    container.innerHTML = `<div class="empty"><strong>${items.length ? "没有匹配的条目" : "还没有条目"}</strong>${items.length ? "换个关键词试试" : "点击上方按钮创建第一条规则"}</div>`;
    return;
  }

  container.innerHTML = filtered.map(item => {
    const enabled = item.enabled !== false;
    const code = item.css || item.code || "";
    return `
      <div class="item-card ${enabled ? "" : "disabled"}" data-id="${item.id}">
        <div class="item-head">
          <span class="item-name">${escapeHtml(item.name || "未命名")}</span>
          <div class="item-actions">
            <button data-act="edit" title="编辑">✎</button>
            <button data-act="delete" class="del" title="删除">🗑</button>
            <label class="switch" title="${enabled ? "禁用" : "启用"}">
              <input type="checkbox" data-act="toggle" ${enabled ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="item-meta">
          <span class="tag ${item.urlPattern ? "" : "all"}">${item.urlPattern ? escapeHtml(item.urlPattern) : "全部 URL"}</span>
        </div>
        <div class="preview">${escapeHtml(code.slice(0, 100)) || "（空内容）"}</div>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".item-card").forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("click", e => {
      if (e.target.closest(".item-actions")) return;
      openEditor(type, id);
    });
    card.querySelector('[data-act="edit"]').addEventListener("click", () => openEditor(type, id));
    card.querySelector('[data-act="delete"]').addEventListener("click", () => quickDelete(type, id));
    card.querySelector('[data-act="toggle"]').addEventListener("change", e => toggleItem(type, id, e.target.checked));
  });
}

async function toggleItem(type, id, enabled) {
  const items = await store.get(type);
  const idx = items.findIndex(i => i.id === id);
  if (idx < 0) return;
  items[idx].enabled = enabled;
  await store.set(type, items);
  await refreshAllLists();

  if (!currentTabId) return;

  if (type === "styles") {
    chrome.tabs.sendMessage(currentTabId, { type: "REFRESH" }, () => void chrome.runtime.lastError);
  } else {
    chrome.tabs.reload(currentTabId, () => void chrome.runtime.lastError);
  }
}

async function quickDelete(type, id) {
  if (!confirm("确定删除这条规则？")) return;
  let items = await store.get(type);
  items = items.filter(i => i.id !== id);
  await store.set(type, items);
  await refreshAllLists();
  refreshPage();
}

function openEditor(type, id = null) {
  editingType = type;
  editingId = id;
  const isNew = !id;
  $("editorTitle").textContent = isNew ? "新建" : "编辑";
  $("deleteItem").style.display = isNew ? "none" : "";
  $("dirtyIndicator").hidden = true;

  if (isNew) {
    $("editName").value = "";
    $("editPattern").value = "";
    $("editCode").value = "";
    updateLineNumbers();
    updateHighlight();
  } else {
    store.get(type).then(items => {
      const item = items.find(i => i.id === id);
      if (!item) return;
      $("editName").value = item.name || "";
      $("editPattern").value = item.urlPattern || "";
      $("editCode").value = item.css || item.code || "";
      updateLineNumbers();
      updateHighlight();
    });
  }
  $("editorDialog").showModal();
  setTimeout(() => $("editName").focus(), 50);
}

async function saveItem() {
  const name = $("editName").value.trim();
  const urlPattern = $("editPattern").value.trim();
  const code = $("editCode").value;
  const codeKey = editingType === "styles" ? "css" : "code";

  if (urlPattern) {
    if (/\s/.test(urlPattern)) {
      alert("URL 匹配模式不能包含空格");
      return;
    }
    if (urlPattern.includes("://") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(urlPattern)) {
      alert("URL 匹配模式格式不正确，请以 http:// 或 https:// 开头");
      return;
    }
  }

  let items = await store.get(editingType);
  if (editingId) {
    const idx = items.findIndex(i => i.id === editingId);
    if (idx >= 0) items[idx] = { ...items[idx], name, urlPattern, [codeKey]: code };
  } else {
    items.push({
      id: Date.now().toString(36),
      name: name || "未命名",
      urlPattern,
      [codeKey]: code,
      enabled: true
    });
  }
  await store.set(editingType, items);
  closeDialog();
  await refreshAllLists();
  refreshPage();
}

async function deleteItem() {
  if (!editingId) return;
  if (!confirm("确定删除这条规则？")) return;
  let items = await store.get(editingType);
  items = items.filter(i => i.id !== editingId);
  await store.set(editingType, items);
  closeDialog();
  await refreshAllLists();
  refreshPage();
}

function closeDialog() {
  $("editorDialog").close();
  editingId = null;
}

function refreshPage() {
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { type: "REFRESH" }, () => void chrome.runtime.lastError);
  }
}

function updateLineNumbers() {
  const code = $("editCode").value;
  const lines = code.split("\n").length;
  $("lineNumbers").textContent = Array.from({ length: lines }, (_, i) => i + 1).join("\n");
}

function updateHighlight() {
  const code = $("editCode").value;
  const type = editingType === "styles" ? "css" : "js";
  $("codeHighlight").innerHTML = highlightCode(code, type) + "\n";
}

function highlightCode(code, type) {
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  if (type === "css") {
    return esc(code)
      .replace(/\/\*[\s\S]*?\*\//g, m => `<span class="tok-comment">${m}</span>`)
      .replace(/([^{}]+)(?=\{)/g, m => `<span class="tok-selector">${m}</span>`)
      .replace(/([-\w]+)(\s*:\s*)([^;{}]+)(;?)/g, (_, prop, colon, val, semi) =>
        `<span class="tok-prop">${prop}</span>${colon}<span class="tok-value">${val}</span>${semi}`)
      .replace(/([{};])/g, '<span class="tok-punct">$1</span>');
  }
  return esc(code)
    .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, m => `<span class="tok-comment">${m}</span>`)
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, m => `<span class="tok-string">${m}</span>`)
    .replace(/\b(const|let|var|function|return|if|else|for|while|new|try|catch|throw|async|await|class|extends|import|from|export|default|switch|case|break|continue|typeof|instanceof|in|of|this|true|false|null|undefined)\b/g,
      m => `<span class="tok-keyword">${m}</span>`)
    .replace(/\b(\d+(?:\.\d+)?)\b/g, m => `<span class="tok-number">${m}</span>`)
    .replace(/([{}()[\];,.=+\-*/<>!&|:?])/g, '<span class="tok-punct">$1</span>');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- 导出：先弹说明，再下载 ----
async function exportRules() {
  $("exportDialog").close();
  const data = await p(chrome.storage.local, "get", ["styles", "scripts"]);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    styles: data.styles || [],
    scripts: data.scripts || []
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pageforge-rules-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- 导入：先解析，再弹层选择模式 ----
async function onImportFileChosen(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = "";

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    alert("导入失败：不是有效的 JSON 文件");
    return;
  }
  if (!payload || typeof payload !== "object" ||
      (!Array.isArray(payload.styles) && !Array.isArray(payload.scripts))) {
    alert("导入失败：文件里没有 styles 或 scripts 数组");
    return;
  }

  const incomingStyles = payload.styles || [];
  const incomingScripts = payload.scripts || [];
  const current = await p(chrome.storage.local, "get", ["styles", "scripts"]);
  const currentStyles = current.styles || [];
  const currentScripts = current.scripts || [];

  const conflictIds = new Set([
    ...currentStyles.map(i => i.id),
    ...currentScripts.map(i => i.id)
  ]);
  const conflicts = [
    ...incomingStyles.filter(i => i && conflictIds.has(i.id)),
    ...incomingScripts.filter(i => i && conflictIds.has(i.id))
  ].length;

  pendingImportPayload = { incomingStyles, incomingScripts, currentStyles, currentScripts, conflicts };

  $("importSummary").textContent =
    `文件包含 ${incomingStyles.length} 条样式、${incomingScripts.length} 条脚本。请选择导入方式：`;
  const hint = $("importConflictHint");
  if (conflicts > 0) {
    hint.hidden = false;
    hint.textContent = `注意：与现有规则存在 ${conflicts} 条同 id 冲突，合并时将以导入文件为准覆盖。`;
  } else {
    hint.hidden = true;
    hint.textContent = "";
  }
  $("importDialog").showModal();
}

function closeImportDialog() {
  $("importDialog").close();
  pendingImportPayload = null;
}

async function executeImport(mode) {
  if (!pendingImportPayload) { closeImportDialog(); return; }
  const { incomingStyles, incomingScripts, currentStyles, currentScripts } = pendingImportPayload;

  const mergeById = (existing, incoming) => {
    const map = new Map(existing.map(i => [i.id, i]));
    for (const item of incoming) {
      if (item && item.id) map.set(item.id, item);
    }
    return [...map.values()];
  };

  const nextStyles = mode === "merge" ? mergeById(currentStyles, incomingStyles) : incomingStyles;
  const nextScripts = mode === "merge" ? mergeById(currentScripts, incomingScripts) : incomingScripts;

  await p(chrome.storage.local, "set", { styles: nextStyles, scripts: nextScripts });
  closeImportDialog();
  await refreshAllLists();
  refreshPage();
}