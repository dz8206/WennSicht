// 阶段 3.1 / 3.2：SPA 路由适配 + 增量扫描（BP 第七章 阶段三）
//
// 1) 路由变化侦测（isolated world 的约束）：
//    - hashchange / popstate 是 DOM 事件，隔离世界收得到；
//    - pushState/replaceState 不触发任何事件，且 S8 禁止注入主世界去 hook，
//      因此用 location.href 轮询（1 秒）兜底 —— 这是内容脚本的标准做法。
// 2) 路由切换后延迟全量重扫（BP：路由切换后延迟全量重扫），并 polite 播报。
// 3) DOM 增量扫描：MutationObserver（childList，不监听 attribute —— 本扩展
//    的所有写入都是属性写入，天然不会自反馈死循环）+ 防抖合并，仅对新增
//    子树跑 headings / interactive（耗时的计算样式规则），noise 保持全文档跑
//    （重复导航判定需要全局视野）。规则自身的标记（role/tabindex/data-ws-*）
//    保证增量重跑幂等。
// 4) 会话 68 · 窄 attribute 观察（**独立** observer）：只监听 <img> 的 src / srcset，
//    用于修「同一 <img> 原地换 src 后描述永久停在第一张 = 陈旧错误信息」。
//    ⚠️ 自反馈防护在 filter 层而非约定层：本扩展只写 alt / aria-label / role /
//    data-ws-*，**从不写 src / srcset** ⇒ observer 不可能因自身写入回调。
//    再加 [data-ws-ignore-obs] 子树排除作纵深防御。零 debounce / 零 setTimeout。
window.WS_SPA_WATCHER = (() => {
  let ctx = null;
  let active = false;
  let observer = null;
  let attrObserver = null;
  let hrefTimer = null;
  let lastHref = '';
  let debounceTimer = null;
  let routeTimer = null;
  let pending = []; // 待增量处理的顶层新增元素

  // 自己注入的节点（live region / 反馈对话框）不做增量处理
  function isOwn(el) {
    return !!(el.closest && el.closest('[data-ws-ignore-obs]'));
  }

  // 会话 68：src / srcset 变更回调。**同步派发、零等待**（MutationObserver 微任务
  // 批次已是最小的合并单位，不再叠 debounce / setTimeout —— owner「程序本身不能拖慢速度」）。
  // 只认 <img>：SVG / CSS background 不在此列（CSS 背景轮换仍由覆盖度披露如实告知）。
  function onImageSrcMutation(records) {
    if (!active) return;
    // 会话 69：MutationObserver 回调里任何一次抛错都会让该回调**静默停摆**
    //（Chrome 不重试、不报错），真实站点高频换 src 时一条畸形记录就能废掉整个观察器。
    // 逐条 try/catch，保证后续记录继续处理。
    for (const m of records || []) {
      try {
        const el = m.target;
        if (!el || el.tagName !== 'IMG' || !el.isConnected) continue;
        if (isOwn(el)) continue; // 扩展自身注入物（纵深防御；filter 已排除）
        window.WS_IMAGE_PIPELINE?.onSrcChanged?.(el);
      } catch { /* 单条记录异常不影响其余 */ }
    }
  }

  function collectTopLevel(records) {
    const added = [];
    for (const m of records || []) {
      for (const n of m.addedNodes || []) {
        // 会话 69：畸形 mutation 记录里可能有非 Element / 已 detach 的节点；
        // 逐条守护，任何一条异常都不能让整批增量扫描停摆。
        try {
          if (!n || n.nodeType !== Node.ELEMENT_NODE) continue;
          if (isOwn(n)) continue;
          added.push(n);
        } catch { /* 忽略单条 */ }
      }
    }
    // 只保留顶层：被本次其它新增元素包含的子节点交给祖先代表
    try {
      return added.filter((el) => {
        try { return !added.some((other) => other !== el && other.contains(el)); }
        catch { return true; } // contains 在 detached / 跨文档节点上可能抛
      });
    } catch { return added; }
  }

  // 会话 68 · 「增减节点」形态的轮播判定（行为，不靠类名、不靠时间窗口）。
  // 同一父容器在**同一批** mutation 里既移除了 <img> 又新增了 <img> ⇒ 判定为「替换式轮播」。
  // 只增不删（无限滚动 / 信息流追加）不算，避免误伤 ⇒ N=10 只落在真正的易变图上。
  // ⚠️ 必须**零等待**直接派发：不能放进 scheduleIncremental 的 500ms 防抖
  //（owner「除了 API 响应，程序本身不能拖慢速度」）。
  function collectReplacedImages(records) {
    const removedParents = new Set();
    for (const m of records || []) {
      for (const n of m.removedNodes || []) {
        // 会话 69：removedNodes 里节点已脱离父级，parentElement 可能为 null；
        // 也有非 Element / 跨文档节点，逐条守护。
        try {
          if (n && n.nodeType === Node.ELEMENT_NODE && n.tagName === 'IMG' && n.parentElement) {
            removedParents.add(n.parentElement);
          }
        } catch { /* 忽略单条 */ }
      }
    }
    if (!removedParents.size) return [];
    const out = [];
    for (const m of records || []) {
      for (const n of m.addedNodes || []) {
        try {
          if (!n || n.nodeType !== Node.ELEMENT_NODE || isOwn(n)) continue;
          // 新增节点本身可能是 img，或包含 img（轮播整块替换）
          if (n.tagName === 'IMG' && n.parentElement && removedParents.has(n.parentElement)) out.push(n);
          for (const i of n.querySelectorAll?.('img') || []) {
            if (i.parentElement && removedParents.has(i.parentElement)) out.push(i);
          }
        } catch { /* 忽略单条 */ }
      }
    }
    return out;
  }

  // 防抖 + max-wait（2026-11-03 会话 45）：只防抖会让**持续高频变动**的页面
  // （直播评论、自动刷新 feed）永远轮不到增量处理——每次变动都重置 500ms 定时器，
  // 变动间隔 <500ms 时 flush 永不发生。首笔入队后最多等 MAX_WAIT 必 flush；
  // 静止页面行为不变（500ms 静默即跑）。
  const MAX_WAIT_MS = 2000;
  let firstPendingAt = 0;

  function scheduleIncremental(els) {
    pending.push(...els);
    if (!firstPendingAt) firstPendingAt = Date.now();
    if (debounceTimer) clearTimeout(debounceTimer);
    const sinceFirst = Date.now() - firstPendingAt;
    const delay = Math.max(0, Math.min(500, MAX_WAIT_MS - sinceFirst));
    debounceTimer = setTimeout(runIncremental, delay);
  }

  async function runIncremental() {
    const roots = pending.filter((el) => el.isConnected);
    pending = [];
    firstPendingAt = 0;
    if (!active || !ctx || !roots.length) return;

    try {
      const rules = window.WS_RULES || {};
      // noise 增量化（2026-11-03 会话 45）：传 roots 后内部只扫新增子树；
      // 重复导航等需要全文档视野的段落由 noise 自行限频（3s + 新增含 nav 才跑），
      // 外层不再需要 3s 节流——高频变动页面每次批次的成本 ≈ 新增子树大小。
      if (typeof rules.noise === 'function') await rules.noise(ctx, roots);
      if (typeof rules.headings === 'function') await rules.headings(ctx, roots);
      if (typeof rules.interactive === 'function') await rules.interactive(ctx, roots);
    } catch {
      // 增量失败不影响页面与既有修复
    }

    // 新增图片交给图片管线观察（懒加载与 SPA 动态图都走这里）
    try {
      const imgs = [];
      for (const root of roots) {
        if (/^(img|svg)$/i.test(root.tagName)) imgs.push(root);
        if (root.querySelectorAll) {
          for (const i of root.querySelectorAll('img, svg')) imgs.push(i);
        }
      }
      if (imgs.length) window.WS_IMAGE_PIPELINE?.observeNew(imgs);
    } catch {
      // 忽略
    }

    // 新增链接交给链接意图管线（SPA 动态渲染出的"了解更多"类链接）
    try {
      const links = [];
      for (const root of roots) {
        if (/^a$/i.test(root.tagName) && root.hasAttribute('href')) links.push(root);
        if (root.querySelectorAll) {
          for (const l of root.querySelectorAll('a[href]')) links.push(l);
        }
      }
      if (links.length) window.WS_LINK_INTENT?.observeNew(links);
    } catch {
      // 忽略
    }

    // 新增图表（画布 / 矢量 / ECharts 容器）交给图表模块
    try {
      const charts = [];
      for (const root of roots) {
        if (root.matches?.('[_echarts_instance_], canvas, svg')) charts.push(root);
        for (const c of root.querySelectorAll?.('[_echarts_instance_], canvas, svg') || []) charts.push(c);
      }
      if (charts.length) window.WS_CHART_TABLE?.observeNew(charts);
      // 图表内容指纹抽查（2026-11-03 会话 45）：canvas 原地重绘不产生 DOM 变动，
      // 借每批增量顺带抽 5 张已处理画布，数据更新的图表描述才跟得上（见 chart-table.js）。
      window.WS_CHART_TABLE?.verifyFresh?.(5);
    } catch {
      // 忽略
    }

    // 新增表格交给表格解析模块
    try {
      const tables = [];
      for (const root of roots) {
        if (root.tagName === 'TABLE') tables.push(root);
        for (const t of root.querySelectorAll?.('table') || []) tables.push(t);
      }
      if (tables.length) window.WS_TABLE_PARSER?.observeNew(tables);
    } catch {
      // 忽略
    }
  }

  function onRouteChange() {
    if (!active || !ctx) return;
    if (routeTimer) clearTimeout(routeTimer);
    // 延迟全量重扫：SPA 框架渲染有先后，立刻扫会扫到半成品 DOM
    routeTimer = setTimeout(async () => {
      if (!active || !ctx) return;
      try {
        const rules = window.WS_RULES || {};
        // lang 适配：路由切换不换 <html>，本规则在此幂等早退，但 SPA 框架
        // 偶尔会在路由后重写 documentElement 属性，重跑一遍保平安（零成本）
        if (typeof rules.langFix === 'function') await rules.langFix(ctx);
        // landmarks 与全量扫描同序（路由切换后 DOM 整体换掉，地标需要重判）
        for (const name of ['noise', 'headings', 'headingHierarchy', 'interactive', 'landmarks']) {
          if (typeof rules[name] === 'function') await rules[name](ctx);
        }
        // v0.2：路由切换后 DOM 整体换掉，open shadowRoot 也要重扫
        window.WS_SHADOW?.scan();
        ctx.announce('页面内容已更新，正在重新整理。'); // 2026-09-28 用户反馈：与 NVDA 自身的更新播报容易混淆，加上动作尾句区分
      } catch {
        // 忽略
      }
      // 路由切换后 DOM 可能整体换掉：链接意图与图表重扫一遍（幂等，已处理的会跳过）
      try {
        if (document.body) {
          window.WS_LINK_INTENT?.observeNew([document.body]);
          window.WS_CHART_TABLE?.observeNew([document.body]);
          window.WS_TABLE_PARSER?.observeNew([document.body]);
        }
      } catch {
        // 忽略
      }
    }, 1200);
  }

  function start(context) {
    if (active) return;
    if (!document.documentElement) return;
    ctx = context;
    active = true;
    lastHref = location.href;

    observer = new MutationObserver((records) => {
      // 会话 69：两段判定各自隔离 —— 任一处因畸形 DOM 抛错，另一段仍要照常跑，
      // 且绝不能让 MutationObserver 回调整体停摆（真实站点高频动态内容的核心防线）。
      try {
        // 会话 68：替换式轮播的行为判定 + 图片入队都**同步派发**（零等待）。
        // 不能等 scheduleIncremental 的 500ms 防抖 —— owner「除了 API 响应本身，
        // 程序不能拖慢速度」。其余规则（headings/interactive 等重计算）仍走防抖。
        const replaced = collectReplacedImages(records);
        if (replaced.length) {
          const pipe = window.WS_IMAGE_PIPELINE;
          pipe?.markVolatile?.(replaced);
          pipe?.observeNew?.(replaced);
        }
      } catch { /* 轮播判定失败不影响常规增量扫描 */ }
      try {
        const tops = collectTopLevel(records);
        if (tops.length) scheduleIncremental(tops);
      } catch { /* 增量扫描失败不影响观察器存活 */ }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 会话 68：独立的窄 attribute 观察。attributeFilter 只含 src / srcset ⇒
    // 扩展自身写入的 alt / data-ws-ai / aria-label 一律不触发（自反馈硬隔离）。
    attrObserver = new MutationObserver(onImageSrcMutation);
    attrObserver.observe(document.documentElement, {
      subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
    });

    window.addEventListener('popstate', onRouteChange, true);
    window.addEventListener('hashchange', onRouteChange, true);
    hrefTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onRouteChange();
      }
    }, 1000);
  }

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    attrObserver?.disconnect(); // 会话 68：关增强必须停掉 src 观察（完全还原）
    attrObserver = null;
    window.removeEventListener('popstate', onRouteChange, true);
    window.removeEventListener('hashchange', onRouteChange, true);
    if (hrefTimer) { clearInterval(hrefTimer); hrefTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (routeTimer) { clearTimeout(routeTimer); routeTimer = null; }
    pending = [];
    firstPendingAt = 0;
    ctx = null;
  }

  return { start, stop, isActive: () => active, isSrcObserverActive: () => !!attrObserver };
})();
