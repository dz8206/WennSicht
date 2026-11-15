// v0.2 第 7 项：焦点位置记忆（零 AI，纯本地）
//
// 解决什么：视障用户在一篇长页面里读到一半，点进某个链接、或按 F5 刷新后，
// 屏幕阅读器又回到页面开头 —— 用户必须重新导航回刚才的位置。本模块记住
// 「离开时读到哪里」，在**后退/前进/刷新**回来时恢复过去。
//
// 为什么用滚动位置作代理：内容脚本读不到 NVDA 的虚拟光标位置（它在 NVDA 进程里）。
// 但用户在浏览模式下用箭头/H 键移动光标时，NVDA 会把当前元素滚入视野 ——
// 因此「视口在文档中的位置」是虚拟光标位置的一个可靠代理。恢复滚动位置后，
// 再把视口顶部的标题做程序化聚焦（tabindex=-1，不抢真实控件焦点），
// 让读屏软件立刻报出「你现在在哪一节」。
//
// 触发条件（从严，宁缺勿错）：
//   - 仅顶层框架（子框架不得滚动/抢焦点）；
//   - 仅导航类型为 reload（刷新）或 back_forward（后退/前进）——正常打开不恢复；
//   - 仅当此前有过有效记录且滚动位置足够深（> 60px，页首无意义）；
//   - 仅当设置页开关「记住并恢复上次浏览位置」为开（默认开）。
//
// 焦点铁律：只有当前焦点悬空（body/html）时才聚焦锚点；锚点一律 tabindex=-1，
// 绝不加正数 tabindex（S1），绝不用 focus() 默认滚动（preventScroll: true，
// 避免把刚恢复的滚动位置又拽回去）。
//
// 存储：ws_positions = { [origin+pathname(+查询串短哈希)]: { y, x, ts } }，上限 60 条。
// 键刻意不含原始查询串（可能含令牌），只放其 32 位哈希。
window.WS_POSITION_MEMORY = (() => {
  const KEY = 'ws_positions';
  const MAX_ENTRIES = 60;
  const MIN_RESTORE_Y = 60; // 离开时在页首附近 → 不恢复（没有意义，且避免多余播报）
  const SAVE_DEBOUNCE_MS = 600;
  // 锚点搜索窗口：视口内 0~260px 的第一个标题；并容忍**视口上沿之上 400px 内**的标题
  //（2026-10-03 owner 实测：恢复点常落在段落中间——它所属小节的标题就在上沿之上一点点，
  // 只认视口内的标题会扑空 → 恢复后没有任何「你在哪」的播报，用户按 D 第一个听到页脚、
  // 按 H「往下没有标题」，一头雾水。向上容差让锚点 = 你正在读的小节标题。）
  const ANCHOR_MIN_TOP = -400;
  const ANCHOR_MAX_TOP = 260;
  // 恢复句先说出口再聚焦的等待窗（打断式短句 ~10 字 ≈ 1 秒出头；覆盖打字机语速差异）
  const FOCUS_AFTER_ANNOUNCE_MS = 1100;

  let enabled = true;
  let active = false;
  let saveTimer = null;
  let lastSavedY = -1;

  // 与 ai.js 同款 32 位 FNV-1a：查询串不进存储，只放哈希
  const fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  };

  function storeKey() {
    const q = location.search || '';
    return location.origin + location.pathname + (q ? '#' + fnv1a(q) : '');
  }

  // 导航类型：'navigate' | 'reload' | 'back_forward' | 'prerender'
  function navType() {
    try {
      return performance.getEntriesByType('navigation')[0]?.type || 'navigate';
    } catch {
      return 'navigate';
    }
  }

  function isReturnNav() {
    const t = navType();
    return t === 'reload' || t === 'back_forward';
  }

  async function loadConfig() {
    try {
      const { ws_ui_config = {} } = await chrome.storage.local.get('ws_ui_config');
      enabled = ws_ui_config.positionMemory !== false; // 默认开
    } catch {
      enabled = true;
    }
  }

  async function readStore() {
    try {
      return (await chrome.storage.local.get(KEY))[KEY] || {};
    } catch {
      return {};
    }
  }

  // ---------- 保存 ----------

  async function saveNow(force) {
    if (!active || !enabled) return;
    const y = Math.round(window.scrollY);
    if (!force && Math.abs(y - lastSavedY) < 4) return;
    lastSavedY = y;
    try {
      const all = await readStore();
      all[storeKey()] = { y, x: Math.round(window.scrollX), ts: Date.now() };
      let entries = Object.entries(all);
      if (entries.length > MAX_ENTRIES) {
        entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
        entries = entries.slice(0, MAX_ENTRIES);
      }
      await chrome.storage.local.set({ [KEY]: Object.fromEntries(entries) });
    } catch {
      // 保存失败不影响浏览（记忆是增值能力）
    }
  }

  function onScroll() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow(false);
    }, SAVE_DEBOUNCE_MS);
  }

  // 离开页面时补一次（滚动防抖可能还没到点）；pagehide 比 beforeunload 可靠
  function onLeave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveNow(true);
  }

  function onHidden() {
    if (document.visibilityState === 'hidden') onLeave();
  }

  // ---------- 恢复 ----------

  // 视口顶部附近的第一个标题作为「你现在在哪」的锚点；
  // 只在焦点悬空时聚焦（S3：绝不从真实控件上抢焦点），tabindex=-1 且不触发滚动
  function focusAnchorNearTop() {
    try {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) return null;
      const heads = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
      let best = null;
      let bestTop = Infinity;
      for (const h of heads) {
        const r = h.getBoundingClientRect();
        if (r.height <= 0) continue; // 折叠/隐藏的标题不算
        if (r.top < ANCHOR_MIN_TOP || r.top > ANCHOR_MAX_TOP) continue;
        if (r.top < bestTop) {
          bestTop = r.top;
          best = h;
        }
      }
      if (!best) return null;
      if (!best.hasAttribute('tabindex')) best.setAttribute('tabindex', '-1'); // 只 -1，不进 Tab 序（S1）
      best.focus({ preventScroll: true });
      return best;
    } catch {
      return null;
    }
  }

  // 返回 { restored, y?, anchor?, reason? }。播报由调用方（content.js）统一发出 ——
  // 与「无障碍增强已开启」合成一句，避免两条 live region 更新互相顶掉。
  //
  // hooks.beforeFocus（2026-10-03 owner 要求）：在程序化聚焦**之前**回调 —— 恢复句
  // 「已自动恢复上次阅读位置」必须抢在 NVDA 读出恢复位置内容之前说出口，否则用户
  // 只听到"突然跳到的内容"一头雾水（polite 播报会被焦点事件的朗读整个清掉，
  // 测试 7 f1 同款教训；content.js 侧走打断式 announce({urgent:true})）。
  // 聚焦刻意延后 FOCUS_AFTER_ANNOUNCE_MS：打断式短句要先说出口，焦点播报才轮得到
  // ——若聚焦紧跟在 announce 之后，NVDA 的焦点朗读会把刚起头的恢复句拦腰截断。
  // 瀑布流等待（2026-11-03 会话 45）：刷新后 feed 还没加载完，scrollHeight 夹住了
  // 恢复点——直接 scrollTo 只能落到已加载内容的底部。等内容长出来再补滚：
  // 按 0.5/1/2/4s 检查（累计 7.5s），每轮跟着已加载内容下移（顺带触发懒加载）。
  // 用户一旦主动滚动（滚轮/触摸/按键）立即让位，绝不和人抢滚动。
  async function waitForHeight(targetY, steps) {
    let userMoved = false;
    const cancel = () => { userMoved = true; };
    window.addEventListener('wheel', cancel, { passive: true, once: true });
    window.addEventListener('touchmove', cancel, { passive: true, once: true });
    window.addEventListener('keydown', cancel, { once: true });
    try {
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, step));
        if (userMoved) return null;
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        if (targetY <= maxY) {
          window.scrollTo(0, targetY);
          return targetY;
        }
        window.scrollTo(0, maxY); // 先到已加载底部，触发下一批加载
      }
      return null;
    } finally {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchmove', cancel);
      window.removeEventListener('keydown', cancel);
    }
  }

  async function restore(hooks = {}) {
    if (!active) return { restored: false, reason: 'inactive' };
    if (!enabled) return { restored: false, reason: 'disabled' };
    if (!isReturnNav()) return { restored: false, reason: 'nav-' + navType() };
    const all = await readStore();
    const rec = all[storeKey()];
    if (!rec || typeof rec.y !== 'number' || rec.y < MIN_RESTORE_Y) {
      return { restored: false, reason: 'no-record' };
    }
    // 页面可能比上次短（内容变化/广告收起）：夹到可滚动范围内
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    let targetY = Math.min(rec.y, maxY);
    // 恢复点比当前页面更深：等内容加载（见 waitForHeight）；超时按当前可达范围恢复
    if (rec.y > maxY) {
      const reached = await waitForHeight(rec.y, [500, 1000, 2000, 4000]);
      if (reached != null) targetY = reached;
    }
    const y = Math.min(targetY, Math.max(0, document.documentElement.scrollHeight - window.innerHeight));
    if (y < MIN_RESTORE_Y) return { restored: false, reason: 'clamped' };
    window.scrollTo(rec.x || 0, y);
    if (typeof hooks?.beforeFocus === 'function') {
      try {
        hooks.beforeFocus();
      } catch {
        /* 播报失败不拦聚焦 */
      }
      await new Promise((r) => setTimeout(r, FOCUS_AFTER_ANNOUNCE_MS));
    }
    const anchor = focusAnchorNearTop();
    return { restored: true, y, anchor: anchor ? (anchor.id || anchor.textContent || '').slice(0, 30) : null };
  }

  // ---------- 生命周期 ----------

  async function start() {
    if (active) return;
    await loadConfig();
    if (!enabled) return;
    active = true;
    lastSavedY = Math.round(window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onHidden);
  }

  function stop() {
    if (!active) return;
    active = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('pagehide', onLeave);
    document.removeEventListener('visibilitychange', onHidden);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  return {
    start,
    stop,
    restore,
    // 供回归验证直接断言（纯本地，零 AI）
    isActive: () => active,
    isEnabled: () => enabled,
    navType,
    storeKey,
  };
})();