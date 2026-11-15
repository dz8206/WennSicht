// v0.2：Shadow DOM / 同源 iframe 可达性（零 AI）
//
// 为什么要单独一个模块：
//   现在所有规则都只跑在 document 这一棵树上。用 Web Components 搭出来的站点，
//   整块内容在 open shadowRoot 里，规则一条都够不到 —— 而且**不报错**，
//   用户只看到"开着增强但有些地方没变"。这一类是最典型的静默失效面。
//
// 做法（不重写规则，复用现成的"增量扫描"入口）：
//   headings / interactive 本来就支持 `(ctx, roots)` 只扫指定子树 —— 把
//   发现的 open shadowRoot 当作 roots 传进去即可，规则代码零改动。
//   · 启动时：全文档搜一遍 open shadowRoot（含嵌套），逐个处理；
//   · 之后：给每个 shadowRoot 挂 MutationObserver 处理其内部新增；
//     另挂一个文档级 observer，只负责发现「新插入的宿主元素」。
//
// 同源 iframe：靠注册时的 allFrames: true（见 content-files 的使用方）。
//   跨域子框架不匹配站点 match pattern，天然不会被注入 —— 这是设计而非缺陷。
//
// 边界（如实）：closed shadowRoot 拿不到（`el.shadowRoot` 为 null），
//   不做 attachShadow 劫持（技术背调 1.3.2：稳定性与反制风险不值）。
window.WS_SHADOW = (() => {
  let ctx = null;
  let active = false;
  // ⚠️ 必须是 let + 在 stop() 里重建成新 WeakSet（WeakSet 没有 clear()）。
  // 2026-10-02 owner 实测抓出的真缺陷：原先只声明一次、stop() 不清，于是「关增强
  // 再开」后 discover() 认为所有 shadowRoot 都已处理过 → 组件内标题/按钮语义
  // 永不重注入（测试 5 的 H/B 在 toggle 之后全部失效的根因）。
  let seen = new WeakSet(); // 已处理的 shadowRoot（弱引用，不阻碍回收）
  const observers = []; // 每个 shadowRoot 的观察器
  let docObserver = null;
  let pending = []; // shadowRoot 内部新增的顶层元素
  let timer = null;

  // 递归收集 root 子树内的 open shadowRoot（只收没见过的）
  function discover(root, out) {
    let els;
    try {
      els = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of els) {
      const sr = el.shadowRoot;
      if (!sr || seen.has(sr)) continue;
      seen.add(sr);
      out.push(sr);
      discover(sr, out); // 嵌套 shadow root
    }
  }

  // 同 discover，但**无视 seen**——供弹窗关闭后的补扫复用（增量集合只为
  // 「不重复处理」服务；补扫的 interactive 规则本身幂等，已有语义的元素按 S3 早退）
  function collectAllRoots(root, out) {
    let els;
    try {
      els = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of els) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      out.push(sr);
      collectAllRoots(sr, out); // 嵌套 shadow root
    }
  }

  // 弹窗关闭后的补扫（2026-10-03 owner 动线实测抓出的真缺陷）：
  //   interactive 规则在弹窗开着时会跳过弹窗外的全部元素（保护网站焦点陷阱，
  //   技术背调 2.2.2）——于是「弹窗开着时发生的任何重扫」（测试 3 的关→开动线、
  //   SPA 路由切换）都会把弹窗外的伪按钮语义**永久漏掉**：弹窗一关没有任何人补扫，
  //   此后 B 键到不了这些按钮（v2-test 测试 3→5 连做即命中）。
  //   此方法重跑顶层文档 + 全部 open shadowRoot 的 interactive 规则（幂等、零 AI）；
  //   headings 不需要——heading-fixer 没有 modal 门控，弹窗开着时照常注入。
  async function rescanInteractiveAfterModal() {
    if (!active || !ctx) return;
    const rules = window.WS_RULES || {};
    const roots = [];
    collectAllRoots(document.documentElement, roots);
    for (const r of roots) {
      try {
        if (typeof rules.interactive === 'function') await rules.interactive(ctx, [r]);
      } catch {
        /* 单棵树失败不影响其它 */
      }
    }
    try {
      if (typeof rules.interactive === 'function') await rules.interactive(ctx);
    } catch {
      /* 顶层文档失败不影响 shadowRoot 侧（上面已完成） */
    }
  }

  function observe(root) {
    try {
      const ob = new MutationObserver((records) => {
        for (const m of records) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) pending.push(n);
          }
        }
        if (pending.length && !timer) timer = setTimeout(flush, 500);
      });
      ob.observe(root, { childList: true, subtree: true });
      observers.push(ob);
    } catch {
      // 观察失败不影响已完成的处理
    }
  }

  async function process(roots) {
    const rules = window.WS_RULES || {};
    for (const r of roots) {
      try {
        if (typeof rules.headings === 'function') await rules.headings(ctx, [r]);
      } catch {
        /* 单棵树失败不影响其它 */
      }
      try {
        if (typeof rules.interactive === 'function') await rules.interactive(ctx, [r]);
      } catch {
        /* 同上 */
      }
      // 图片交给图片管线（懒加载/晚加载由管线自己的观察器接续）
      try {
        const imgs = [...r.querySelectorAll('img, svg[role="img"], input[type="image"]')];
        if (imgs.length) window.WS_IMAGE_PIPELINE?.observeNew(imgs);
      } catch {
        /* 忽略 */
      }
      observe(r);
    }
  }

  // shadowRoot 内部新增 → 直接对该子树跑增量（新出现的嵌套 root 一并发现）
  async function flush() {
    timer = null;
    if (!active || !ctx) return;
    const tops = pending.filter((el) => el.isConnected);
    pending = [];
    if (!tops.length) return;
    const newRoots = [];
    for (const el of tops) {
      const sr = el.shadowRoot;
      if (sr && !seen.has(sr)) {
        seen.add(sr);
        newRoots.push(sr);
      }
      discover(el, newRoots);
    }
    if (newRoots.length) await process(newRoots);
    const rules = window.WS_RULES || {};
    try {
      if (typeof rules.headings === 'function') await rules.headings(ctx, tops);
    } catch {
      /* 忽略 */
    }
    try {
      if (typeof rules.interactive === 'function') await rules.interactive(ctx, tops);
    } catch {
      /* 忽略 */
    }
  }

  // 全文档搜一遍（启动与 SPA 路由切换后调用）
  async function scan() {
    if (!active || !ctx || !document.documentElement) return;
    const roots = [];
    discover(document.documentElement, roots);
    if (roots.length) await process(roots);
  }

  function start(context) {
    if (active) return;
    ctx = context;
    active = true;
    // 文档级观察器：只负责发现「新插入的宿主元素」，光 DOM 侧由 spa-watcher 负责
    try {
      docObserver = new MutationObserver((records) => {
        if (!active || !ctx) return;
        const cand = [];
        for (const m of records) {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) cand.push(n);
          }
        }
        if (!cand.length) return;
        const out = [];
        for (const el of cand) {
          const sr = el.shadowRoot;
          if (sr && !seen.has(sr)) {
            seen.add(sr);
            out.push(sr);
          }
          discover(el, out);
        }
        if (out.length) process(out);
      });
      docObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      /* 忽略 */
    }
    scan();
  }

  function stop() {
    active = false;
    ctx = null;
    for (const ob of observers) ob.disconnect();
    observers.length = 0;
    try {
      docObserver?.disconnect();
    } catch {
      /* 忽略 */
    }
    docObserver = null;
    pending = [];
    seen = new WeakSet(); // 重建：再次 start 时才能重新发现并处理所有 shadowRoot
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // 实时枚举当前文档全部 open shadowRoot（2026-11-03 会话 45）：
  // page-qa / summarizer / layout-map 等「读」类收集器用它穿透 Web Components——
  // 按 need 现查而非维护注册表：永远新鲜，也不会漏掉两次扫描之间新建的 root。
  // closed shadowRoot 读不到（平台限制），收集器侧如实缺省。
  function collectRoots() {
    const out = [];
    try {
      if (document.documentElement) collectAllRoots(document.documentElement, out);
    } catch {
      /* 忽略 */
    }
    return out;
  }

  return {
    start,
    stop,
    scan,
    rescanInteractiveAfterModal,
    isActive: () => active,
    roots: collectRoots,
  };
})();