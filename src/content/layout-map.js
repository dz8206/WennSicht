// v0.2 第 10 项 · 页面布局地图（用户口径，不可回退）：
//   **只播「哪块该读 / 哪块可跳过」，绝不播方位**——盲用户不左右导航，
//   「右侧是广告」对用户无意义；方位（getBoundingClientRect 的几何关系）只作
//   内部判断特征，不出现在播报里。
//
// 触发：快捷键 `layout-map`（无默认键，chrome://extensions/shortcuts 自行绑定）
//   → SW 路由 WS_LAYOUT_REQUEST → 本模块在**顶层文档**执行。
//
// 输出格式（编号 + 该读/可跳过 + 一句为什么，纯本地零 AI）：
//   「本页共 5 块内容。第 1 块，值得读：主内容，共约 1200 字。第 2 块，可跳过：导航栏，只有链接列表。」
//   为什么要有「为什么」：只报「1 2 3」用户无从判断跳不跳过；一句定性（导航/广告/主内容）
//   才能支撑跳读决策。顺序 = 文档序（页面上从上到下），不提左右。
//
// 判定特征（全部本地、零 AI）：
//   - landmark 语义（nav/main/aside/footer/header/form/[role]）→ 直接定类；
//   - 「重复短链接组」（≥6 个短链接、平均字数 ≤6）→ 导航组（可跳过）；
//   - 「大文字块」（正文 ≥400 字）或 ≥2 个段落 → 该读；
//   - 广告特征（类名/ID 命中广告词 token，与 noise-cleaner 同词表思路）→ 可跳过。
window.WS_LAYOUT_MAP = (() => {
  let ctx = null; // content.js 经 attach(buildCtx()) 注入

  const clean = (s, n = 60) =>
    (window.WS_SANITIZE
      ? window.WS_SANITIZE.cleanText(String(s || '').replace(/\s+/g, ' ').trim(), n)
      : String(s || '').replace(/\s+/g, ' ').trim().slice(0, n));

  function visible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hasAttribute('data-ws-hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[data-ws-ignore-obs], [role="status"]')) return false; // 本扩展的播报与注入物
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  // 文档序顶层块：从 **body** 取（不能从 main 取——地图必须包含导航/页脚/广告位，
  // 只看 main 就永远看不到「可跳过」的区域，而可跳过恰恰是地图的价值）。
  // 纯容器块（无文字无链接无结构语义，如动态挂载点）不单列；
  // 顶层块太少（只有一两个大 wrapper）时下钻一层找结构。
  // 上限 12：播报是线性的，块太多地图本身就变成噪音。
  const BLOCK_TAGS = /^(SECTION|ARTICLE|NAV|ASIDE|HEADER|FOOTER|MAIN|UL|OL|TABLE|FORM|DIV|P|FIGURE)$/;
  const STRUCTURAL_SEL = 'nav,aside,footer,header,section,article,main,form,table,ul,ol,figure,[role]';
  function isBlockish(el) {
    return BLOCK_TAGS.test(el.tagName) || !!el.getAttribute('role');
  }
  function topLevelBlocks() {
    const root = document.body;
    if (!root) return [];
    let blocks = [...root.children].filter((el) => visible(el) && isBlockish(el));
    // 纯容器（无结构语义、无文字、无链接）不单列——报「第 N 块：辅助内容」是噪音
    blocks = blocks.filter((el) => {
      if (el.matches(STRUCTURAL_SEL)) return true;
      return textLen(el) >= 40 || el.querySelector('a');
    });
    if (blocks.length < 3) {
      for (const el of [...blocks]) {
        const kids = [...el.children].filter((k) => visible(k) && isBlockish(k));
        if (kids.length >= 3) {
          blocks.splice(blocks.indexOf(el), 1, ...kids);
        }
      }
    }
    // 巨型容器下钻（2026-11-04 会话 46，长页实测）：瀑布流的「一个巨大 feed 容器」
    // 不拆开的话，整页地图只剩三四块、长页分页播报永远不触发。文字量 ≥1500 且
    // 有 ≥3 个**结构性**子块（SECTION/ARTICLE/UL/…，裸 P/H 不算——散文容器一拆
    // 就变成一堆「辅助内容」碎块）才下钻一层，最多两轮（防极端嵌套失控）。
    const DRILL_SEL = 'section,article,nav,aside,main,ul,ol,table,form,figure,[role]';
    for (let pass = 0; pass < 2; pass++) {
      const out = [];
      let changed = false;
      for (const el of blocks) {
        const kids = [...el.children].filter((k) => visible(k) && k.matches(DRILL_SEL));
        if (textLen(el) >= 1000 && kids.length >= 3) {
          out.push(...kids);
          changed = true;
        } else {
          out.push(el);
        }
      }
      blocks = out;
      if (!changed) break;
    }
    // shadow 穿透（2026-11-03 会话 45）：Web Components 的区块进地图，追加在 light 块之后
    try {
      for (const sr of window.WS_SHADOW?.roots?.() || []) {
        blocks.push(...[...sr.children].filter((el) => visible(el) && isBlockish(el)));
      }
    } catch {
      /* shadow 枚举失败不影响 light DOM 部分 */
    }
    // 不在这里截断（2026-11-03 会话 45）：长页播报改为「总数 + 视口详报 + 分页续听」，
    // 截断应该发生在播报层而不是数据层——砍掉的数据永远答不了。
    return blocks;
  }

  // 链接文字统计（导航组判定用）
  function linkStats(el) {
    const links = [...el.querySelectorAll('a')].filter(visible);
    const texts = links.map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const avg = texts.length ? texts.join('').length / texts.length : 0;
    return { count: texts.length, avg };
  }

  // 文字量（去空白后的字数，播报里的「约 N 字」）
  function textLen(el) {
    return (el.textContent || '').replace(/\s+/g, '').length;
  }

  // 单块定性：{ kind: 'read' | 'skip', why }
  function classifyBlock(el) {
    const tag = el.tagName;
    const role = el.getAttribute('role') || '';
    const cls = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '')).toLowerCase();

    // —— 可跳过：结构性非内容区 ——
    if (tag === 'NAV' || role === 'navigation') return { kind: 'skip', why: '导航栏，只有链接列表' };
    if (tag === 'ASIDE' || role === 'complementary') return { kind: 'skip', why: '侧栏，多为推荐或相关内容' };
    if (tag === 'FOOTER' || role === 'contentinfo') return { kind: 'skip', why: '页脚，版权与备案链接' };
    if (tag === 'HEADER' || role === 'banner') return { kind: 'skip', why: '页头，站点名称与主导航' };
    if (tag === 'FORM' || role === 'search' || /search/.test(cls)) return { kind: 'skip', why: '搜索或表单区' };

    // —— 可跳过：广告/推荐特征（整词 token，避免 read/head/add 误伤，同 noise-cleaner 思路）——
    const AD_RE = /(^|[^a-z])(ads?|advert|banner|promo|sponsor|recommend|related|hot|rank|sidebar)([^a-z]|$)/;
    if (AD_RE.test(cls)) return { kind: 'skip', why: '推荐或广告区块' };

    // —— 可跳过：重复短链接组（导航组的通用形态，无 landmark 时的主要识别手段）——
    const { count, avg } = linkStats(el);
    if (count >= 6 && avg <= 6) return { kind: 'skip', why: '链接列表，多为站内导航或栏目入口' };

    // —— 该读：大文字块 / 多段正文 ——
    const len = textLen(el);
    if (len >= 400) return { kind: 'read', why: `主内容，共约 ${len} 字` };
    const paras = [...el.querySelectorAll('p')].filter(visible).length;
    if (paras >= 2) return { kind: 'read', why: `正文内容，共约 ${len} 字` };
    // 带标题的正文小节（2026-11-04 会话 46）：巨型容器下钻后的典型形态——
    // 一节 = 一个标题 + 一两段正文，旧阈值（400 字/2 段）全够不着，会被误判「可跳过」，
    // 用户照地图跳过的是真内容。有标题且 ≥40 字就算该读（40 字以下基本只剩标题壳）。
    if (len >= 40 && el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
      return { kind: 'read', why: `正文小节，共约 ${len} 字` };
    }

    // —— 其余：小链接组 / 工具条等 → 可跳过 ——
    if (count >= 3) return { kind: 'skip', why: '链接或操作列表' };
    return { kind: 'skip', why: '辅助或装饰内容' };
  }

  // 块名：块内第一个标题（h1-h6 / role=heading）或 aria-label，让「第 N 块」有名字可记
  function blockTitle(el) {
    if (el.closest('[data-ws-ignore-obs], [role="status"]')) return '';
    const h = el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const t = h ? (h.textContent || '').trim() : (el.getAttribute('aria-label') || '').trim();
    return clean(t, 20);
  }

  function buildMap() {
    return topLevelBlocks().map((el, i) => {
      const c = classifyBlock(el);
      return { index: i + 1, el, kind: c.kind, why: c.why, title: blockTitle(el) };
    });
  }

  // ---------- 长页播报（2026-11-03 会话 45：瀑布流上「前 12 块」= 只见页首） ----------
  // 块多于 LONG_PAGE_ITEMS 时：第一句报总数与当前视口位置，详报视口前后共 5 块；
  // 再按一次快捷键从上次停的地方续 5 块。短线性格式（mapAnnounce）保持不变。
  const LONG_PAGE_ITEMS = 12;
  const LONG_WINDOW = 5;
  let longCursor = null; // null = 首按（以视口为中心）；数字 = 下一次详报的起点下标

  function nearItemIndex(items) {
    // 2026-11-06 会话 48：与页面问答/摘要同一把尺子 —— 阅读线（视口顶部 12%）上那个元素
    // 落在哪一块。旧实现取「top ≤ 260 的最靠下块」，短小节长页上会报到下方 2–3 块，
    // 用户听到的「你现在在第 N 块附近」永远比真实位置靠后。
    // 直接复用页面问答的锚点：同一条阅读线、同一套避开 fixed/sticky 与扩展注入物的规则
    //（2026-11-06 会话 48：三个功能必须共用一把尺子，不再各算各的 y）。
    const qa = window.WS_PAGE_QA;
    // 会话 49（最高优先级）：NVDA 浏览光标停在哪一节，就报哪一节。
    // 视口阅读线只是桥接不可用时的**代理**——owner 真机 H 到「第27节」时阅读线压的
    // 是「第25节」（top=81 vs 阅读线 y≈107），几何绝不能抢在确定信号前面。
    // 只在确实持有新鲜光标锚点时介入；没有锚点时完全沿用下面的几何兜底（既有回归不变量）。
    if (qa?.freshAnchor?.() && qa?.matchByCursor) {
      const byCursor = qa.matchByCursor(items, (it) => it.title);
      if (byCursor !== null && byCursor >= 0) return byCursor;
    }
    // 会话 53：有确定信号（NVDA 虚拟缓冲浏览行 / 页面行）时，地图与问答共用
    // 同一个「当前块」标题 —— 弹窗已抢焦点也能精确报出所在块。
    const pt = qa?.preciseTitleForMap?.();
    if (pt) {
      const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
      const t = norm(pt);
      if (t.length >= 4) {
        for (let i = 0; i < items.length; i++) {
          const it = norm(items[i].title);
          if (it && (t.includes(it) || it.includes(t))) return i;
        }
      }
    }
    // 光标锚点是「嵌套/演示标题」时标题对不上任何地图块 ⇒ 用纯 DOM 文档序归到所属块，
    // 与 page-qa.js 的 domOrderBlock 同口径（会话 50 环境矩阵 k=6 实证）。
    // 会话 52：折叠选区（NVDA 浏览光标）与桥接锚点同等优先，按 DOM 文档序归到地图块。
    const ae = qa?.cursorAnchorEl?.() || qa?.caretAnchorEl?.();
    if (ae && ae.isConnected) {
      let best = -1;
      for (let i = 0; i < items.length; i++) {
        try {
          const e = items[i].el;
          if (e === ae) { best = i; break; }
          if (e.compareDocumentPosition(ae) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
        } catch { /* 忽略 */ }
      }
      if (best >= 0) return best;
    }
    // 会话 50：导航递推已降级为 estimate 的候选排序提示，不再参与定位（环境矩阵实证其不稳）。
    // 无独立信号时下面的几何只用来**生成候选**，mapAnnounceLong 会如实说「无法确定」。
    const anchor = qa?.anchorAtLine ? qa.anchorAtLine() : null;
    const y = anchor?.y ?? (qa?.readingLineY
      ? qa.readingLineY()
      : Math.max(60, Math.min(Math.round((window.innerHeight || 800) * 0.12), 240)));
    let el = anchor?.el || null;
    if (!el) {
      try {
        el = document.elementFromPoint(Math.round((window.innerWidth || 800) * 0.5), y);
      } catch { el = null; }
      if (el && el.closest && el.closest('[data-ws-ignore-obs]')) el = null;
    }
    // 阅读线压在块间空隙时会命中「包住整篇正文的大容器」（实测 #sectionsHost，含 30 个 h2）。
    // 对这种容器做包含/文档序反查会误命中页首说明块 —— 一律交给下面的几何覆盖。
    const elIsContainer = !!(el && el.querySelectorAll
      && el.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').length >= 2);
    if (el && !elIsContainer) {
      // ① 取**最深**的包含块：顶层块可能是包住全文的巨型容器（它也 contains），
      // 直接返回第一个命中会永远报「第 1 块」。字数最少的就是最里面那一层。
      let deep = -1;
      let deepLen = Infinity;
      for (let i = 0; i < items.length; i++) {
        try {
          if (!items[i].el.contains(el)) continue;
          const L = (items[i].el.textContent || '').length;
          if (L < deepLen) { deepLen = L; deep = i; }
        } catch { /* 忽略单块 */ }
      }
      if (deep >= 0) return deep;
      // ② 块之间有间隙：取文档序里在 el 之前的最后一块
      let before = -1;
      for (let i = 0; i < items.length; i++) {
        try {
          if (items[i].el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) before = i;
        } catch { /* 忽略单块 */ }
      }
      if (before >= 0) return before;
    }
    // ③ 几何覆盖（**覆盖阅读线 y 的那一块**，取最深）：容器锚点、命中测试失效
    //（窗口被遮挡 / 视口 0）时都靠它，比文档序可靠。旧实现只有「top<=y 最靠下」，
    // 长页前半段只有第 1 块满足 ⇒ 恒报「第 1 块附近」。
    let covering = -1;
    let coveringLen = Infinity;
    for (let i = 0; i < items.length; i++) {
      try {
        const r = items[i].el.getBoundingClientRect();
        if (r.top <= y && r.bottom > y) {
          const L = (items[i].el.textContent || '').length;
          if (L < coveringLen) { coveringLen = L; covering = i; }
        }
      } catch { /* 忽略单块 */ }
    }
    if (covering >= 0) return covering;
    let best = -1;
    let bestTop = -Infinity;
    for (let i = 0; i < items.length; i++) {
      let top = 0;
      try {
        top = items[i].el.getBoundingClientRect().top;
      } catch {
        continue;
      }
      if (top <= y && top > bestTop) {
        bestTop = top;
        best = i;
      }
    }
    return best;
  }

  function describeItem(x) {
    const name = x.title ? `「${x.title}」` : '';
    return x.kind === 'read'
      ? `第 ${x.index} 块${name}，值得读：${x.why}`
      : `第 ${x.index} 块${name}，可跳过：${x.why}`;
  }

  // 短线性格式（纯函数，导出供回归验证；≤12 块时与旧版逐字一致）
  function mapAnnounce(items) {
    if (!items.length) return '这个页面结构简单，直接从上往下听即可。';
    const parts = items.map(describeItem);
    return `本页共 ${items.length} 块内容。${parts.join('。')}。`;
  }

  function mapAnnounceLong(items, start) {
    const reads = items.filter((x) => x.kind === 'read').length;
    const near = nearItemIndex(items);
    // 会话 52：estimate 时**照常给出最佳答案**，但显式标「位置为估计」+ 附近候选，
    // 不再拒绝服务（owner 明确否决「我无法确定」）。精确态措辞一字不动。
    const conf = window.WS_PAGE_QA?.focusConfidence?.() || 'estimate';
    let where = '';
    if (conf === 'estimate') {
      const cand = [];
      // 会话 54：与问答一致，候选窗口 ±2 块（视口代理在长页靠后可能偏前约 2 节）
      for (let k = Math.max(0, near - 2); k >= 0 && k < items.length && k <= near + 2 && cand.length < 5; k++) {
        if (items[k].title) cand.push(`第 ${items[k].index} 块「${items[k].title}」`);
      }
      where = (near >= 0 && items[near].title
        ? `你现在大约在第 ${items[near].index} 块「${items[near].title}」附近（位置为估计）。`
        : '我暂时没读到光标的确定位置。')
        + (cand.length ? `附近的小节有：${cand.join('、')}。` : '')
        + '也可以直接问「第 N 节讲什么」。';
    } else if (near >= 0) {
      where = `你现在在第 ${items[near].index} 块${items[near].title ? `「${items[near].title}」` : ''}附近。`;
    }
    const parts = items.slice(start, start + LONG_WINDOW).map(describeItem);
    const nextStart = start + LONG_WINDOW;
    const tail = nextStart < items.length
      ? `再按一次快捷键，从第 ${items[nextStart].index} 块继续。`
      : '以上已到页面末尾。';
    return `本页共 ${items.length} 块内容，其中值得读 ${reads} 块。${where}${parts.join('。')}。${tail}`;
  }

  async function run() {
    if (window.top !== window) return; // 只在顶层文档响应（快捷键消息会广播到所有框架）
    // 会话 49：地图没有「弹窗打开那一刻」，靠常驻轮询 + 主动刷新确保光标锚点是新鲜的。
    // 本机回环 <50ms；桥接不可用时 SW 立刻返回失败，250ms 上限保证不拖慢按键。
    try {
      await Promise.race([
        window.WS_PAGE_QA?.requestCursor?.() || Promise.resolve(),
        new Promise((r) => setTimeout(r, 250)),
      ]);
    } catch { /* 桥接不可用：退回视口代理 */ }
    const items = buildMap();
    if (items.length <= LONG_PAGE_ITEMS) {
      longCursor = null; // 短页：下次回到视口中心模式
      announceLine(mapAnnounce(items));
      return;
    }
    let start;
    if (longCursor == null) {
      const near = nearItemIndex(items);
      start = Math.max(0, (near >= 0 ? near : 0) - 2);
    } else {
      start = Math.min(longCursor, Math.max(0, items.length - 1));
    }
    longCursor = start + LONG_WINDOW;
    announceLine(mapAnnounceLong(items, start));
  }

  function announceLine(text) {
    if (ctx?.announce) {
      // 2026-11-06 会话 48：布局地图是**用户按键主动要的**播报，必须带 source:'user'。
      // content.js 的长播报保护会把「朗读窗口」内的其它播报排队；本模块自己的长格式
      // 播报（≥120 字）恰好会开这样一个窗口 ⇒ 不标记 user 时，用户再按一次快捷键要等
      // 几十秒才听到，而期间从别处滚到新位置后再按，听到的仍是**第一次的「第 1 块」**。
      // 这正是 owner 报「site structure 识别很烂」的可听症状（定位其实算对了）。
      ctx.announce(text, { source: 'user' });
      return;
    }
    // 兜底：自建一次性 polite region（150ms 挂钩等待，见 REFERENCE 坑清单）
    try {
      const r = document.createElement('div');
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      r.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);';
      document.body.appendChild(r);
      setTimeout(() => {
        r.textContent = text;
        setTimeout(() => r.remove(), 4000);
      }, 150);
    } catch {
      /* 无 body 等极端场景放弃 */
    }
  }

  return {
    attach: (context) => {
      ctx = context || null;
    },
    detach: () => {
      ctx = null;
    },
    run,
    // 供回归验证（纯本地，零 AI）
    buildMap,
    mapAnnounce,
    mapAnnounceLong,
    nearItemIndex, // 「你现在在第 N 块」的定位本身，供对拍直接断言
  };
})();
