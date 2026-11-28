// 在页面主世界执行，接收来自 content script 的脚本代码并执行
window.addEventListener("__utk_inject_script__", (e) => {
  const { code, id } = e.detail || {};
  if (!code) return;
  try {
    new Function(code)();
    window.dispatchEvent(new CustomEvent("__utk_inject_result__", {
      detail: { id, ok: true }
    }));
  } catch (err) {
    window.dispatchEvent(new CustomEvent("__utk_inject_result__", {
      detail: { id, ok: false, error: String(err) }
    }));
  }
});