// v0.2 第 10 项 · 动态变化播报（用户口径，不可回退）：
//   **默认关、站点级开**——「页面自己变了我告诉你」对部分站点（秒杀页、聊天页、
//   动态列表）有价值，但对多数页面是打扰（计数器、时钟、轮播都在「变」）。
//   因此：全局默认关闭；用户在设置页为单个站点开启后，本模块才在该站点工作。
//
// 机制（纯本地零 AI，S6 只读不写）：
//   MutationObserver 观察子树增删（top frame）→ 变化归类为「新增内容 / 移除内容」→
//   防抖 1.5 秒汇总成一句播报（「页面有更新：新增 2 段内容，移除 1 段内容。」）→
//   两次播报至少间隔 8 秒（刷屏站点不连环轰炸）→ 每页累计播报 ≤ 30 条（上限后静默）。
//
// 「有意义的内容」判定（避免把 JS 噪音当内容）：
//   - 只看**元素节点**的插入/移除，且带 ≥40 字可见文本（按钮、图标、广告位不算）；
//   - 排除：本扩展注入物（data-ws-ignore-obs / data-ws-*）、aria-hidden 子树、
//     被本扩展隐藏的（data-ws-hidden）、SCRIPT/STYLE/LINK/META、媒体与表单控件本身；
//   - 移除检测：本轮记录「已见内容块」，下轮发现 isConnected=false 的计为移除。
window.WS_LIVE_UPDATES = (() => {
  const DEBOUNCE_MS = 1500;
  const MIN_GAP_MS = 8000;
  // 防轰炸口径（2026-11-03 会话 45 改）：原「每页 30 条后永久静默」在瀑布流上等于
  // 几分钟后功能消失。防刷屏的本意是**速率**，不是终身配额 → 改为 5 分钟滚动窗口，
  // 每 5 分钟最多 30 条，窗口过后自动恢复。
  const MAX_ANNOUNCE_PER_WINDOW = 30;
  const ANNOUNCE_WINDOW_MS = 5 * 60 * 1000;
  const MIN_TEXT = 40;
  const STORE_KEY = 'ws_live_sites';
  const SITE_CAP = 60; // 与 ws_positions 同口径的 FIFO 上限，防无限增长

  let ctx = null;
  let observer = null;
  let enabled = false; // 本站点开关（ws_live_sites[origin].on）
  let debounceTimer = null;
  let flushTimer = null; // 间隔未到时的补播挂起（与 debounce 不同：不丢变化）
  let lastAnnounceAt = 0;
  let announceCount = 0;
  let announceWindowStart = Date.now();
  const seenLive = new Set(); // 本页出现过的「内容块」元素（移除检测用）

  const ORIGIN = location.origin;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'BR', 'HR',
    'IMG', 'SVG', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON',
  ]);

  function textLen(el) {
    return (el.textContent || '').replace(/\s+/g, '').length;
  }

  // 是否「有意义的内容块」
  function isContent(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.tagName && SKIP_TAGS.has(el.tagName)) return false;
    if (el.closest('[data-ws-ignore-obs]')) return false; // 扩展自身注入物
    if (el.closest('[aria-hidden="true"]')) return false;
    if (el.closest('[data-ws-hidden]')) return false; // 本扩展隐藏的噪音
    if (el.hasAttribute && /(^|data)-ws-/.test(el.getAttribute('data-ws-ignore-obs') || '')) return false;
    if (textLen(el) < MIN_TEXT) return false;
    // 可见性：display:none 的挂载点先不入册（挂载点内容真正插入时会再触发）
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch {
      return false;
    }
    return true;
  }

  // 站点级开关存取（设置页逐站开；登记 = 开启增强时顺手记录，FIFO 上限防膨胀）
  async function registerSite() {
    if (window.top !== window) return;
    try {
      const { [STORE_KEY]: store = {} } = await chrome.storage.local.get(STORE_KEY);
      if (store[ORIGIN]) return; // 已登记
      const entries = Object.entries(store);
      if (entries.length >= SITE_CAP) {
        entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        entries.shift();
      }
      entries.push([ORIGIN, { on: false, at: Date.now() }]);
      await chrome.storage.local.set({ [STORE_KEY]: Object.fromEntries(entries) });
    } catch {
      /* 存储失败只是不登记，不影响其它功能 */
    }
  }

  async function readEnabled() {
    try {
      const { [STORE_KEY]: store = {} } = await chrome.storage.local.get(STORE_KEY);
      return store[ORIGIN]?.on === true;
    } catch {
      return false;
    }
  }

  function summarize(added, removed) {
    if (!added.length && !removed.length) return '';
    const a = added.length;
    const r = removed.length;
    const parts = [];
    if (a) parts.push(`新增 ${a} 段内容`);
    if (r) parts.push(`移除 ${r} 段内容`);
    // 第一段新内容若带标题，报标题帮用户决定要不要去看
    const first = added.find((el) => el.querySelector?.('h1,h2,h3,h4,h5,h6,[role="heading"]'));
    let tail = '';
    if (first) {
      const h = first.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      const t = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (t) tail = `，最新一块是「${t}」`;
    }
    return `页面有更新：${parts.join('，')}${tail}。`;
  }

  function flush() {
    debounceTimer = null;
    if (!enabled || !ctx?.announce) return;
    // 滚动窗口（2026-11-03 会话 45）：过窗自动重置；窗口内超 30 条才静默（防刷屏站轰炸）
    if (Date.now() - announceWindowStart > ANNOUNCE_WINDOW_MS) {
      announceWindowStart = Date.now();
      announceCount = 0;
    }
    if (announceCount >= MAX_ANNOUNCE_PER_WINDOW) return;

    const now = Date.now();
    const wait = MIN_GAP_MS - (now - lastAnnounceAt);
    if (wait > 0) {
      // 间隔未到：**挂起补播，绝不丢弃本轮变化**。
      // 2026-10-02 owner 实测抓出的真缺陷（测试 14「手快一点就听不到」）：旧实现这里
      // 直接 return，但**移除块已在上面从 seenLive 删除** → 被抑制的那一轮变化永久
      // 丢失（用户快速「注入→移除」后再也听不到）；新增块的 __wsNew 标记也会错位。
      // 改为：延迟到间隔满足时再统一汇总播报，既防连环轰炸又不丢事件。
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, wait);
      }
      return;
    }

    const removed = [];
    for (const el of seenLive) {
      if (!el.isConnected) removed.push(el);
    }
    for (const el of removed) seenLive.delete(el);

    const added = [...seenLive].filter((el) => el.__wsNew);
    for (const el of added) delete el.__wsNew;

    const msg = summarize(added, removed);
    if (!msg) return;
    lastAnnounceAt = now;
    announceCount++;
    ctx.announce(msg);
  }

  function onMutations(records) {
    if (!enabled) return;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        // 找内容块：插入的可能是包装层，逐层向上找最近的「内容块」
        const target = node.closest ? (isContent(node) ? node : node.querySelector?.('div,section,article,li,p')) : null;
        if (target && isContent(target) && !seenLive.has(target)) {
          target.__wsNew = true;
          seenLive.add(target);
        }
      }
      // removedNodes 在回调里已断开， isConnected 检查统一放 flush()
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  async function start(context) {
    ctx = context || null;
    if (window.top !== window) return; // 只在顶层文档观察与播报
    await registerSite(); // 首次访问自动登记（默认关），设置页才会列出本站
    enabled = await readEnabled();
    if (!enabled || observer) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    seenLive.clear();
    enabled = false;
    ctx = null;
    announceCount = 0;
    lastAnnounceAt = 0; // 重新开启后第一次变化应立即播报，不继承旧的间隔窗口
  }

  // 设置页开启某站点后，已在页面上的增强无需刷新即可生效（content.js 收消息后调用）
  async function refresh() {
    if (window.top !== window) return;
    const on = await readEnabled();
    if (on && !observer && ctx) {
      enabled = true;
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      stop();
    }
  }

  return { start, stop, refresh, isOn: () => enabled && !!observer };
})();
