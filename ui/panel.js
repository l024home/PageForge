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

const $ = id => document.getElementById(id);

const ICON_CARD = '<path fill="currentColor" d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>';
const ICON_LIST = '<path fill="currentColor" d="M3 5h18v4H3V5zm0 6h18v4H3v-4zm0 6h18v4H3v-4z"/>';

(async () => {
  const [tab] = await p(chrome.tabs, "query", { active: true, currentWindow: true });
  currentTabId = tab?.id;
  currentUrl = tab?.url || "";
  $("siteLabel").textContent = "当前站点：" + (currentUrl ? new URL(currentUrl).hostname : "—");

  // 恢复主题与展示模式
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

  // 导入导出
  $("exportBtn").addEventListener("click", exportRules);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", importRules);

  // Tab 切换
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

  // 搜索
  $("styleSearch").addEventListener("input", e => {
    filters.styles = e.target.value.toLowerCase();
    renderList("styles", "styleList");
  });
  $("scriptSearch").addEventListener("input", e => {
    filters.scripts = e.target.value.toLowerCase();
    renderList("scripts", "scriptList");
  });

  // 跨域
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

  // 新建
  $("addStyleBtn").addEventListener("click", () => openEditor("styles"));
  $("addScriptBtn").addEventListener("click", () => openEditor("scripts"));
  $("closeEditor").addEventListener("click", closeDialog);
  $("cancelItem").addEventListener("click", closeDialog);
  $("saveItem").addEventListener("click", saveItem);
  $("deleteItem").addEventListener("click", deleteItem);

  // 编辑器快捷键与行号
  const codeEl = $("editCode");
  codeEl.addEventListener("input", updateLineNumbers);
  codeEl.addEventListener("scroll", () => {
    $("lineNumbers").scrollTop = codeEl.scrollTop;
  });
  codeEl.addEventListener("keydown", e => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = codeEl.selectionStart;
      const end = codeEl.selectionEnd;
      codeEl.value = codeEl.value.slice(0, start) + "  " + codeEl.value.slice(end);
      codeEl.selectionStart = codeEl.selectionEnd = start + 2;
      updateLineNumbers();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveItem();
    }
  });
  ["editName", "editPattern", "editCode"].forEach(id => {
    $(id).addEventListener("input", () => { $("dirtyIndicator").hidden = false; });
  });

  renderList("styles", "styleList");
  renderList("scripts", "scriptList");
})();

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function applyView(view) {
  document.body.dataset.view = view;
  const icon = $("viewIcon");
  if (icon) icon.innerHTML = view === "card" ? ICON_LIST : ICON_CARD;
  $("viewBtn").title = view === "card" ? "切换为列表展示" : "切换为卡片展示";
}

function updateCorsStatus(on) {
  const dot = $("corsStatus").querySelector(".dot");
  dot.className = "dot " + (on ? "on" : "off");
  $("corsStatusText").textContent = on ? "已启用（仅 localhost/127.0.0.1）" : "未启用";
}

async function renderList(type, containerId) {
  const items = await store.get(type);
  const container = $(containerId);
  const filter = filters[type] || "";
  const filtered = items.filter(item =>
    !filter ||
    (item.name || "").toLowerCase().includes(filter) ||
    (item.urlPattern || "").toLowerCase().includes(filter)
  );

  const all = await Promise.all([store.get("styles"), store.get("scripts")]);
  const activeCount = [...all[0], ...all[1]].filter(i => i.enabled !== false).length;
  $("activeCount").textContent = activeCount + " 条生效";

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
  renderList(type, type === "styles" ? "styleList" : "scriptList");

  if (!currentTabId) return;

  if (type === "styles") {
    chrome.tabs.sendMessage(currentTabId, { type: "REFRESH" }, () => void chrome.runtime.lastError);
  } else {
    if (!enabled) {
      chrome.tabs.reload(currentTabId, () => void chrome.runtime.lastError);
    } else {
      chrome.tabs.sendMessage(currentTabId, { type: "REFRESH" }, () => void chrome.runtime.lastError);
    }
  }
}

async function quickDelete(type, id) {
  if (!confirm("确定删除这条规则？")) return;
  let items = await store.get(type);
  items = items.filter(i => i.id !== id);
  await store.set(type, items);
  renderList(type, type === "styles" ? "styleList" : "scriptList");
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
  } else {
    store.get(type).then(items => {
      const item = items.find(i => i.id === id);
      if (!item) return;
      $("editName").value = item.name || "";
      $("editPattern").value = item.urlPattern || "";
      $("editCode").value = item.css || item.code || "";
      updateLineNumbers();
    });
  }
  if (isNew) updateLineNumbers();
  $("editorDialog").showModal();
  setTimeout(() => $("editName").focus(), 50);
}

async function saveItem() {
  const name = $("editName").value.trim();
  const urlPattern = $("editPattern").value.trim();
  const code = $("editCode").value;
  const codeKey = editingType === "styles" ? "css" : "code";

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
  renderList(editingType, editingType === "styles" ? "styleList" : "scriptList");
  refreshPage();
}

async function deleteItem() {
  if (!editingId) return;
  if (!confirm("确定删除这条规则？")) return;
  let items = await store.get(editingType);
  items = items.filter(i => i.id !== editingId);
  await store.set(editingType, items);
  closeDialog();
  renderList(editingType, editingType === "styles" ? "styleList" : "scriptList");
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ===== 导入导出：仅用户创建的 CSS / JS 规则 =====

async function exportRules() {
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
  a.download = `universal-toolkit-rules-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importRules(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ""; // 允许重复选择同一文件

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

  const mode = confirm("点击“确定”合并到现有规则（按 id 去重，同 id 以导入文件为准）；点击“取消”覆盖现有规则。")
    ? "merge" : "replace";

  const current = await p(chrome.storage.local, "get", ["styles", "scripts"]);
  const mergeById = (existing, incoming) => {
    const map = new Map(existing.map(i => [i.id, i]));
    for (const item of incoming) {
      if (item && item.id) map.set(item.id, item);
    }
    return [...map.values()];
  };

  const nextStyles = mode === "merge"
    ? mergeById(current.styles || [], payload.styles || [])
    : (payload.styles || []);
  const nextScripts = mode === "merge"
    ? mergeById(current.scripts || [], payload.scripts || [])
    : (payload.scripts || []);

  await p(chrome.storage.local, "set", { styles: nextStyles, scripts: nextScripts });
  renderList("styles", "styleList");
  renderList("scripts", "scriptList");
  refreshPage();
  alert(`导入完成：${nextStyles.length} 条样式，${nextScripts.length} 条脚本`);
}