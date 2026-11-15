// 快捷键文案（会话 74 · owner 要求）：
// 播报里凡是提到「Ctrl+Shift+Z」的地方，都必须说**用户实际绑定的那个组合键**
//（用户在 chrome://extensions/shortcuts 改过键就跟着变）。
// 本文件必须在其它 content 脚本之前注入：它们用 window.WS_SHORTCUT.toggle() 取实时值。
//
// 取值的两条路：① 问 SW（只有扩展自己能调 chrome.commands.getAll，拿到的是**实时**绑定）；
// ② 退回 storage 里的缓存（SW 每次被问都会顺手刷新该缓存）。
// 两条都拿不到时用 manifest 里的默认值，保证任何情况下都有话可说。
(function () {
  const DEFAULT_TOGGLE = 'Ctrl+Shift+Z';
  const state = { toggle: DEFAULT_TOGGLE };

  const clean = (v) => (typeof v === 'string' ? v.trim() : '');

  async function refresh() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'WS_GET_SHORTCUTS' });
      const t = clean(r?.shortcuts?.toggle);
      if (t) { state.toggle = t; return; }
    } catch { /* SW 未就绪：走缓存 */ }
    try {
      const o = await chrome.storage.local.get('ws_shortcut_map');
      const t = clean(o?.ws_shortcut_map?.toggle);
      if (t) state.toggle = t;
    } catch { /* 忽略 */ }
  }

  // 用户改了键不用刷新页面：SW 刷新缓存时写 storage，这里跟着更新
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ws_shortcut_map) return;
      const t = clean(changes.ws_shortcut_map.newValue?.toggle);
      if (t) state.toggle = t;
    });
  } catch { /* 忽略 */ }

  window.WS_SHORTCUT = {
    toggle: () => state.toggle,
    // 「连按两次 X」：手势名只写组合键本身，动作另用一个词说清楚
    //（owner 2026-10-31：「Ctrl+Shift+Z Z」会被读屏念成「z z」，听着像要按字母 Z）。
    forceText: () => `连按两次 ${state.toggle}`,
    refresh,
  };

  refresh();
})();
