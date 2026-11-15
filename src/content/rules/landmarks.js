// v0.2：虚拟地标重建（零 AI，纯规则）
//
// 为什么做：中文网站普遍不写 <nav>/<main>/<footer>/[role="search"]，屏幕阅读器用户
// 因此没有任何「区块级」跳转手段 —— NVDA 的 D / Shift+D 与 NVDA+F7 元素列表都要求
// 页面存在地标，否则只能从第一个标题一路听下去。本规则在页面「完全没有某类地标」时补一个。
//
// 只补四类，且每类都「页面已有 → 整体跳过」（宁缺勿假，S3）：
//   导航 navigation / 搜索 search / 主内容 main / 页脚 contentinfo
// 刻意不做：页头 banner（多数页头本身就是导航，重复标注反而两个地标互相打架）、
//           侧栏 complementary（真实站的侧栏常是广告位，标成"辅助内容"是误导）。
//
// 护栏：
//   - 已带 role / 在 aria-hidden 子树内 / 已被本扩展隐藏 → 不参与；
//   - 元素已有 aria-label / aria-labelledby → 只补 role，不覆盖名字（S3）；
//   - 全部经 ctx.setAttr 写入，一键还原由 journal 负责；
//   - 已注入的 role 会让探测器早退，天然幂等。
//
// 增量口径（2026-11-03 会话 45）：nav/footer/main 是「整页」概念，对增量子树做
// 伪局部判定没有意义；但**无限滚动会改变「页面底部」这一事实**——初始 DOM 是短页
// 没有页脚，feed 加载十屏后底部出现了像页脚的区块。因此增量时按
// 「高度增长 ≥1.5 倍 且 距上次 ≥20s」节流**重跑全量**（各探测器对已注入 role 幂等），
// 而不是假装修子树。
window.WS_RULES = window.WS_RULES || {};

// ⚠️ 会话 69：刻意用 **var + window 单例**，不用 let/const。扩展重载后 SW 自愈重注入
// 会在同一个隔离世界再执行一次本文件；顶层 let 重复声明抛 `SyntaxError: Identifier
// 'lastLandmarkRun' has already been declared` ⇒ 整批重注入中断（实测抓到）。
// 挂 window 保证节流时间戳跨重注入保留；万一丢失，代价只是多跑一次全量重扫
// （各探测器对已注入 role 幂等），可接受。此改动不改变任何产品行为。
var LANDMARK_STATE = window.__WS_LANDMARK_STATE__ || (window.__WS_LANDMARK_STATE__ = {
  lastRun: 0,
  lastHeight: 0,
});

WS_RULES.landmarks = async (ctx, roots) => {
  if (!document.body || !document.documentElement) return;
  if (Array.isArray(roots) && roots.length) {
    const now = Date.now();
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if (now - LANDMARK_STATE.lastRun < 20000) return;      // 节流：20s 内不重跑
    if (docH < LANDMARK_STATE.lastHeight * 1.5) return;    // 高度没显著增长：旧结论仍成立
  }
  LANDMARK_STATE.lastRun = Date.now();
  LANDMARK_STATE.lastHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );

  const LABELS = {
    navigation: '站点导航',
    search: '站内搜索',
    contentinfo: '页脚',
    main: '主内容',
  };

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textLen = (el) => clean(el.textContent).length;
  const docY = (el) => el.getBoundingClientRect().top + window.scrollY;

  const visible = (el) => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    } catch {
      return false;
    }
  };

  // 通用排除：已被本扩展隐藏 / 已有 role / aria-hidden 子树内
  const skip = (el) =>
    !el ||
    el.nodeType !== Node.ELEMENT_NODE ||
    ctx.isHidden(el) ||
    el.hasAttribute('role') ||
    !!el.closest('[aria-hidden="true"]');

  const bodyText = textLen(document.body);
  const assigned = new Set();

  // ---------- 1) 站点导航：页面顶部区域的链接簇 ----------
  function findNav() {
    // 页面已有「像样的」导航地标 → 整体跳过（哪怕它只覆盖页脚导航，
    // 也不再加第二个，避免两个无名导航互相混淆）
    for (const n of document.querySelectorAll('nav, [role="navigation"]')) {
      if (n.querySelectorAll('a[href]').length >= 3) return null;
    }

    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (!visible(a) || skip(a)) continue;
      if (!clean(a.textContent)) continue; // 纯图标链接不参与（无法据此判断是导航条）
      if (a.closest('main, article')) continue; // 正文里的链接不是站点导航
      if (docY(a) >= 400) continue; // 只看文档顶部 400px 内的链接
      links.push(a);
    }
    if (links.length < 5) return null; // 少于 5 条不成其为导航条

    // 最低公共祖先：取所有链接的共同容器
    const chainOf = (el) => {
      const arr = [];
      for (let n = el; n; n = n.parentElement) arr.push(n);
      return arr;
    };
    let chain = chainOf(links[0]);
    for (const a of links.slice(1)) {
      const set = new Set(chainOf(a));
      const idx = chain.findIndex((n) => set.has(n));
      if (idx < 0) return null; // 理论上不可达（都有 body/html 祖先）
      chain = chain.slice(idx);
    }
    const lca = chain[0];

    if (!lca || lca === document.body || lca === document.documentElement) return null;
    if (skip(lca)) return null;
    // 容器本身已是结构型标签 → 交给原生语义，不叠加
    if (['MAIN', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'ARTICLE', 'FORM'].includes(lca.tagName)) return null;
    if (lca.querySelectorAll('a[href]').length > 60) return null; // 链接农场 / 站点地图
    if (textLen(lca) > 1500) return null; // 整页级容器
    if (lca.querySelectorAll('h1, h2').length > 1) return null; // 含多个正文章节标题 → 不是导航条
    if (lca.querySelectorAll('input, select, textarea').length > 3) return null; // 表单区不是导航
    if (bodyText > 0 && textLen(lca) / bodyText > 0.5) return null; // 占了半页文字 → 是内容容器
    return lca;
  }

  // ---------- 2) 站内搜索：带"搜索"线索的输入框所在容器 ----------
  function findSearch() {
    if (document.querySelector('[role="search"]')) return null;

    const HINT_RE = /搜索|搜一下|搜商品|查询|search/i;
    const boxes = [];
    for (const i of document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')) {
      if (!visible(i) || ctx.isHidden(i)) continue;
      if (i.closest('[aria-hidden="true"]')) continue;
      const hint = [
        i.getAttribute('placeholder'),
        i.getAttribute('aria-label'),
        i.getAttribute('title'),
        i.getAttribute('name'),
        i.getAttribute('id'),
      ]
        .filter(Boolean)
        .join(' ');
      if (i.type !== 'search' && !HINT_RE.test(hint)) continue;
      boxes.push(i);
    }
    if (!boxes.length) return null;
    boxes.sort((a, b) => docY(a) - docY(b));
    const box = boxes[0]; // 站点搜索通常在页面最上方

    // 优先整表单（role=search 的标准落点）；没有表单时退到输入框的直接容器
    const form = box.closest('form');
    if (form && !skip(form) && textLen(form) < 500 && form.querySelectorAll('input, select, textarea').length <= 4) {
      return form;
    }
    const p = box.parentElement;
    if (!p || p === document.body || skip(p)) return null;
    if (p.querySelectorAll('input, select, textarea').length !== 1) return null; // 容器里要只有这一个输入框
    if (textLen(p) > 200) return null; // 容器太大 → 不只是搜索
    return p;
  }

  // ---------- 3) 页脚：页面底部、以链接为主、无正文标题的块 ----------
  function findFooter() {
    if (document.querySelector('footer, [role="contentinfo"]')) return null;
    if (bodyText < 300) return null;
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if (docH < 900) return null; // 一屏以内的页面没有"页脚"概念

    const cands = [];
    for (const el of document.body.querySelectorAll('div, section, ul')) {
      if (!visible(el) || skip(el)) continue;
      if (el.closest('main, article, [role="main"], nav, [role="navigation"]')) continue;
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      if (top < docH * 0.72) continue; // 必须在页面下部
      if (r.height < 40 || r.height > 900) continue;
      if (r.width < window.innerWidth * 0.4) continue; // 页脚通常整幅横跨
      if (el.querySelectorAll('a[href]').length < 3) continue; // 以链接为主
      if (el.querySelectorAll('input, select, textarea, form, button').length > 2) continue; // 表单区不是页脚
      if (el.querySelectorAll('h1, h2').length > 0) continue; // 含正文大标题 → 不是页脚
      const t = textLen(el);
      if (t < 20 || t > 1200) continue;
      if (t > bodyText * 0.4) continue; // 占了四成文字 → 是主内容，不是页脚
      cands.push(el);
    }
    if (!cands.length) return null;
    // 只保留最内层候选（被其它候选包含的丢弃），避免标到外层大包装
    const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    inner.sort(
      (a, b) =>
        b.querySelectorAll('a[href]').length - a.querySelectorAll('a[href]').length || docY(b) - docY(a)
    );
    return inner[0];
  }

  // ---------- 4) 主内容 ----------
  // 正文纯度：自身文字 − 3×链接文字（正文区链接占比低；导航/相关阅读/页脚链接多）
  function linkTextLen(el) {
    let n = 0;
    for (const a of el.querySelectorAll('a[href]')) n += clean(a.textContent).length;
    return n;
  }

  function mainGuards(el, minShare) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (skip(el)) return false;
    if (el.closest('nav, aside, footer, header, [role="contentinfo"], [role="navigation"]')) return false;
    if (el.querySelectorAll('a[href]').length > 80) return false;
    const len = textLen(el);
    if (len < 300) return false;
    if (len < bodyText * minShare) return false;
    if (el.querySelectorAll('p, h1, h2, h3, h4, li, article, section, blockquote, pre, td').length < 3) return false;
    if (linkTextLen(el) > len * 0.5) return false; // 一半以上是链接文字 → 链接列表，不是正文
    return true;
  }

  function findMain() {
    if (document.querySelector('main, [role="main"]')) return null;
    if (bodyText < 400) return null; // 内容太少，无从判断

    // ① 高置信路径：逐层下降，取"仍占父级六成文字"的最深容器（内容集中的页面）
    let cur = document.body;
    for (let depth = 0; depth < 15; depth++) {
      let best = null;
      let bestLen = 0;
      for (const child of cur.children) {
        if (!visible(child)) continue;
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        const l = textLen(child);
        if (l > bestLen) {
          bestLen = l;
          best = child;
        }
      }
      // 子元素不再占据父级 60% 文字 → 当前层就是内容容器；叶子太小也停
      if (!best || bestLen < 300 || bestLen < textLen(cur) * 0.6) break;
      cur = best;
    }
    if (mainGuards(cur, 0.35)) return cur;

    // ② 兜底路径（真实站常态，2026-10-01 在 index.html 上实测暴露）：
    //    真实中文站普遍是「导航 + 正文 + 侧栏 + 广告 + 页脚」并列，正文块常常只占
    //    全页文字的 15%~40% —— 只走 ① 会一个主内容地标都不出（本页实测：正文最
    //    大子块仅占 22%，直接被 60% 门槛挡掉）。这里按「文字多、链接少、块级元素足」
    //    三条打分挑一个，护栏与 ① 同级但没有"占优"这条不可能满足的条件。
    const cands = [];
    for (const el of document.body.querySelectorAll('div, section, article, td')) {
      if (!visible(el)) continue;
      if (!mainGuards(el, 0.15)) continue;
      cands.push(el);
    }
    if (!cands.length) return null;
    const score = (el) => textLen(el) - 3 * linkTextLen(el);
    // 去掉"被别的候选包住、而里面那个并没少多少内容"的外层包装，保留更具体的
    const inner = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o) && score(o) >= score(el) * 0.8));
    inner.sort((a, b) => score(b) - score(a) || textLen(b) - textLen(a));
    return inner[0];
  }

  // ---------- 执行：逐个探测并立即写入（后续探测能看见前面的标注） ----------
  const detectors = [
    ['navigation', findNav],
    ['search', findSearch],
    ['contentinfo', findFooter],
    ['main', findMain],
  ];
  for (const [role, fn] of detectors) {
    let el = null;
    try {
      el = fn();
    } catch {
      el = null; // 单个探测器失败不影响其它
    }
    if (!el || assigned.has(el)) continue;
    assigned.add(el);
    ctx.setAttr(el, 'role', role);
    // S3：只补缺失的名字，绝不覆盖站点已写的 aria-label / aria-labelledby
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
      ctx.setAttr(el, 'aria-label', LABELS[role]);
    }
  }
};