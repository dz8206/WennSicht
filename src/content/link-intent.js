// P1：链接意图补充（BP P1「对『点击这里』『了解更多』等模糊链接，结合上下文生成意图标签」）
//
// 用户可感知的效果：屏幕阅读器按链接导航时，听到的不再只是"点击这里"，
// 而是"点击这里，链接，AI描述：打开具体内容的详情页"——名字不变，补的是描述。
//
// 为什么注入 aria-description 而不是改文本：
//   S4 明令"绝不修改链接文本、aria-label"。aria-description 是**补充描述**，
//   不参与可访问名称计算，既能被读出，又完全不改变链接的名字与既有语义。
//   元素已有 aria-label / aria-labelledby / aria-description / aria-describedby / title
//   时一律不动（S3 不覆盖已有语义 + 作者已给出描述）。
//
// 为什么用决策模型（WS_AI_DECIDE）而不是文本模型：
//   本任务是**封闭集分类**（去详情页 / 去列表页 / 翻页 / 下载 / 页内操作 / 站外跳转），
//   决策模型直接返回类型化概率、可做置信度门控，单次成本约为文本模型的 1/30，
//   与 scene.js 走同一条链路（见 ai.js 的 decide()）。
//
// 隐私（S9 / S10）：
//   **绝不把 URL / href 发给模型**（S10 明文规定不传输 URL）。
//   出站内容只有：页面标题、链接文字、最近标题、周边文本——全部先过 WS_SANITIZE。
//
// 成本纪律：
//   - **单页预算已移除**（`AI_BUDGET_PER_PAGE = Infinity`，2026-09-30 owner 拍板：
//     除「图片日限」外的一切预算限制全部取消，去重保留 —— 见
//     AGENT_MEMORY/README.md「第十会话」条目）。**不要把这里改回 8**：
//     模糊链接本就稀少（整串匹配封闭词典），真正的成本闸门是中转配额与图片日限；
//     刻意保留 `budgetUsed` 计数逻辑，将来要恢复预算只改这个常量即可。
//   - 结果按 origin 跨刷新缓存（key = 链接文字 + 最近标题 + 周边文本），刷新不重复计费；
//   - 任何失败静默（增值能力，绝不影响规则修复与页面本身）。
//
// 播报：
//   aria-description 由屏幕阅读器在导航到链接时自行读出，**不需要额外动作**；
//   悬停或焦点停留 5 秒可重听一遍（与图片管线的 dwell 机制一致，不抢焦点）。
window.WS_LINK_INTENT = (() => {
  const AI_PREFIX = 'AI描述：';
  const UNCERTAIN_SUFFIX = '（AI不确定，仅供参考）';
  const MARK = 'data-ws-link-intent';
  const CACHE_KEY = 'ws_ai_link_intents';
  const CACHE_MAX_PER_ORIGIN = 300;
  const AI_BUDGET_PER_PAGE = Infinity;
  const DWELL_MS = 5000;

  const ORIGIN = location.origin;

  // 模糊链接词典：整串匹配（匹配前先剥掉首尾空白与装饰符号）。
  // 宁缺勿假——只有"文字本身完全没告诉用户它去哪"的链接才进管线，
  // "配送范围查询""查看商品资质"这类自解释链接一律不动。
  const VAGUE = new Set([
    '点击', '点击这里', '点击进入', '点击查看', '点此', '点这里', '这里', '此处',
    '查看', '查看详情', '查看全部', '查看所有', '详情', '查看全文', '阅读全文',
    '全文', '继续阅读', '更多', '了解更多', '查看更多', '了解详情',
    'more', 'load more', 'click', 'click here', 'here', 'read more', 'learn more',
    'detail', 'details', 'see more',
  ]);

  // 首尾装饰符号（箭头、书名号、省略号、点号、竖线等）
  const DECOR_RE = /^[\s\u200b·•*>》»→…\-.。、|]+|[\s\u200b·•*>》»→…\-.。、|]+$/g;

  // 决策模型封闭集 → 中文标签。`unknown` 刻意不注入任何内容（宁缺勿假）。
  const INTENT_LABEL = {
    detail: '打开具体内容的详情页',
    list: '查看更多同类内容',
    page_nav: '翻页或跳转到页面其他区域',
    download: '下载文件或附件',
    action: '在当前页面执行一个操作',
    external: '跳转到本站以外的网站',
  };

  const QUESTIONS = {
    intent: {
      type: 'choice',
      instructions: '用户点击这个链接后，最可能到哪里、或发生什么？可参考 link_kind 与 link_path（公开路径模板，已去参数），page_path 是当前页路径。',
      criteria: {
        detail: '打开某个商品、文章、帖子、房源等具体内容的详情页；若 link_path 指向具体条目/文件（如 /notice/2026q3.html），即使文字是「点击这里」也选此项',
        list: '进入某类内容的列表页、栏目页或"更多结果"页；若 link_path 指向 index/列表/栏目（如 /notice/index.html），即使文字是「了解更多」也选此项',
        page_nav: '翻页（上一页/下一页），或跳到本页面的其他区域（link_kind 为 in_page 时选此项）',
        download: '下载文件、附件、表格、图片等（link_kind 为 file_download 时选此项）',
        action: '在当前页面就地执行一个操作（展开/收起、收藏、领取、提交等），不跳转；仅当 link_path 没有指向具体内容/列表时才选此项',
        external: '跳转到本站以外的网站或第三方应用（link_kind 为 external_site 时选此项）',
        unknown: '给出的信息不足以判断它到底去哪里',
      },
    },
  };

  let ctx = null;
  let stopped = true;
  let running = false;
  let aiAvailable = false;
  let budgetUsed = 0;
  let cache = {};
  let seen = new WeakSet();
  let processed = new WeakSet();

  const queue = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 配置与缓存 ----------

  async function loadConfig() {
    const stored = await chrome.storage.local.get(['ws_ai_config', CACHE_KEY]);
    const ai = stored.ws_ai_config || {};
    // 与 scene.js 一致：只看主开关与分类模型槽位，密钥由 SW 侧负责解密校验
    // v0.2 第 8 项：敏感站点（政务/医疗/金融）默认不外发链接文本
    aiAvailable =
      window.WS_AI_SLOTS?.enabled?.(ai) === true &&
      window.WS_AI_SLOTS?.decisionReady?.(ai) === true && // 决策模型永走默认档 default（2026-10-04 口径；读键含旧名回退）
      window.WS_AI_PRIVACY?.allowed?.() !== false;
    const all = stored[CACHE_KEY] || {};
    cache = all[ORIGIN] || {};
  }

  async function persistCache() {
    const all = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
    // 会话 80（双实例）：两本 content script 各自只看到自己处理的链接，直接整桶覆盖会把
    // 对方刚写的条目冲掉（实测缓存只剩 2 条）。这里改为**与存储里的该源缓存合并**。
    cache = { ...(all[ORIGIN] || {}), ...cache };
    const entries = Object.entries(cache);
    if (entries.length > CACHE_MAX_PER_ORIGIN) {
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      cache = Object.fromEntries(entries.slice(entries.length - CACHE_MAX_PER_ORIGIN));
    }
    all[ORIGIN] = cache;
    await chrome.storage.local.set({ [CACHE_KEY]: all });
  }

  // ---------- 模糊链接判定（纯本地，零 AI） ----------

  function linkText(a) {
    return (a.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVague(text) {
    if (!text) return false;
    const key = text.replace(DECOR_RE, '').trim().toLowerCase();
    if (!key) return true; // 纯符号链接（→ >> » 之类）
    return VAGUE.has(key);
  }

  // 是否值得处理。任何一条不满足就保持原样（保守注入）。
  function eligible(a) {
    if (!(a instanceof HTMLAnchorElement) || !a.hasAttribute('href')) return false;
    if (a.hasAttribute(MARK)) return false; // 幂等：本次已处理
    if (a.closest('[aria-hidden="true"]') || a.closest('[data-ws-hidden]')) return false;
    if (a.closest('[data-ws-ignore-obs]')) return false; // 扩展自身注入物（反馈对话框等）
    // S3：作者已给出名称或描述来源 → 一律不碰
    if (a.hasAttribute('aria-label') || a.hasAttribute('aria-labelledby')) return false;
    if (a.hasAttribute('aria-description') || a.hasAttribute('aria-describedby')) return false;
    if ((a.getAttribute('title') || '').trim()) return false;
    return isVague(linkText(a));
  }

  // ---------- 上下文收集（S10：不含 URL） ----------

  function clip(text, maxLen) {
    return window.WS_SANITIZE
      ? window.WS_SANITIZE.cleanText(text, maxLen)
      : String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  // 链接所在区块内最近的标题，作为"这段内容在讲什么"的线索
  function nearestHeading(a) {
    let node = a.closest('li, article, section, figure, td, form, div');
    for (let depth = 0; node && depth < 4; depth++) {
      const h = node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (h) return (h.textContent || '').replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      node = parent ? parent.closest('li, article, section, figure, td, form, div') : null;
    }
    return '';
  }

  function aroundText(a) {
    const holder = a.closest('li, p, figure, td, article, section, div') || a.parentElement;
    if (!holder) return '';
    const full = (holder.textContent || '').replace(/\s+/g, ' ').trim();
    return full.split(linkText(a)).join(' ').replace(/\s+/g, ' ').trim();
  }

  // 链接去向的**本地类别**（不传 URL，只传推导出的类别，S10）。
  // 目的：让"下载/站外/页内跳转"这类从文字看不出来的意图有判据——
  // BP 痛点里的"无法预判点击后果"正需要这个信号。
  function hrefKind(a) {
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw) return 'unknown';
    if (/^mailto:/i.test(raw)) return 'email';
    if (/^tel:/i.test(raw)) return 'phone';
    if (/^javascript:/i.test(raw)) return 'script_action';
    if (raw.startsWith('#')) return 'in_page';
    try {
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin) return 'external_site';
      if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt)$/i.test(u.pathname)) return 'file_download';
      return 'same_site_page';
    } catch {
      return 'unknown';
    }
  }

  function buildState(a) {
    return {
      title: clip(document.title || '', 80),
      link_text: clip(linkText(a), 40),
      section_heading: clip(nearestHeading(a), 60),
      // 周边文本用 context()：额外剥掉 URL（URL 对判断意图没用，还可能带跟踪参数）
      around_text: window.WS_SANITIZE
        ? window.WS_SANITIZE.context(aroundText(a), 80)
        : clip(aroundText(a), 80),
      // 本地推导的去向类别（枚举值，不是网址）
      link_kind: hrefKind(a),
      // 会话 80 · owner：网站公开的地址路径可以给模型（不含 query/hash/数字标识），
      // 用于区分 detail/list；完整 URL 仍然不发。
      page_path: window.WS_SANITIZE?.pathTemplate?.(location.href) || '',
      link_path: window.WS_SANITIZE?.pathTemplate?.(a.href) || '',
    };
  }

  // ---------- 注入（S5：AI 内容必须带前缀） ----------

  function applyIntent(a, rec) {
    const label = INTENT_LABEL[rec.c];
    if (!label) return;
    ctx.setAttr(a, 'aria-description', AI_PREFIX + label + (rec.confident ? '' : UNCERTAIN_SUFFIX));
    ctx.setAttr(a, MARK, '1');
  }

  // ---------- 单条处理 ----------

  async function processOne(a) {
    if (!a.isConnected || !eligible(a)) return;
    const st = buildState(a);
    const cacheKey = [st.link_text, st.section_heading, st.around_text, st.link_path].join('\u0000');

    const cached = cache[cacheKey];
    if (cached) {
      applyIntent(a, cached); // 跨刷新缓存命中：零 AI 成本
      return;
    }

    if (!aiAvailable) return;

    // 会话 80 · owner：规则已高度确定的行内去向，不再问决策模型。
    // ① 域名与本页不同 ⇒ 一定是跳到其他页面（external，无需模型）；
    // ② hrefKind 的结构信号在封闭集里只有一个对应标签：
    //    in_page（#锚点）→ 翻页/跳到页面其他区域；file_download（同站文件后缀）→ 下载。
    // 省调用，也避免模型把 .pdf 误判成「详情页」。（完整 URL 仍然不发给模型）
    if (st.link_kind === 'external_site' || st.link_kind === 'in_page' || st.link_kind === 'file_download') {
      const LOCAL_LABEL = { external_site: 'external', in_page: 'page_nav', file_download: 'download' };
      const rec = { c: LOCAL_LABEL[st.link_kind], confident: true, ts: Date.now() };
      cache[cacheKey] = rec;
      await persistCache();
      applyIntent(a, rec);
      return;
    }

    if (budgetUsed >= AI_BUDGET_PER_PAGE) return;
    budgetUsed++;

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'WS_AI_DECIDE', state: st, questions: QUESTIONS });
    } catch {
      return; // 调用失败：保持原样，不注入噪音
    }
    if (!resp?.ok) return;

    const ans = resp.answers?.intent || {};
    const choice = ans.choice;
    if (!choice || choice === 'unknown') return; // 无法判断 → 什么都不做

    const rec = { c: choice, confident: typeof ans.confidence === 'number' ? ans.confidence >= 0.6 : true, ts: Date.now() };
    cache[cacheKey] = rec;
    await persistCache();
    applyIntent(a, rec);
  }

  // ---------- 队列（串行，避免并发抢占主线程与额度） ----------

  function enqueue(a) {
    if (stopped || !a.isConnected) return;
    if (seen.has(a) || processed.has(a)) return;
    seen.add(a);
    queue.push(a);
    run();
  }

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length) {
        const a = queue.shift();
        if (processed.has(a)) continue;
        processed.add(a);
        try {
          await processOne(a);
        } catch {
          // 单条失败不影响其余链接
        }
        await sleep(120); // 让出主线程，绝不连续阻塞页面
      }
    } finally {
      running = false;
    }
  }

  async function scan(roots) {
    if (stopped || !ctx || !aiAvailable) return;
    const rootList = Array.isArray(roots) && roots.length ? roots : [document];
    for (const r of rootList) {
      if (!r || !r.isConnected) continue;
      if (r.matches?.('a[href]')) enqueue(r);
      for (const a of r.querySelectorAll?.('a[href]') || []) enqueue(a);
    }
  }

  // ---------- dwell：停留 5 秒重听（不抢焦点、不打断朗读） ----------

  let dwellTimer = null;

  function scheduleDwell(a) {
    cancelDwell();
    dwellTimer = setTimeout(() => {
      const desc = a.getAttribute('aria-description') || '';
      if (desc && ctx) ctx.announce(desc);
    }, DWELL_MS);
  }

  function cancelDwell() {
    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
  }

  function onDwellOver(e) {
    const a = e.target?.closest?.(`a[${MARK}]`);
    if (a) scheduleDwell(a);
    else cancelDwell();
  }

  function onDwellFocus(e) {
    const a = e.target?.closest?.(`a[${MARK}]`);
    if (a) scheduleDwell(a);
  }

  function startDwell() {
    document.addEventListener('pointerover', onDwellOver, true);
    document.addEventListener('pointerout', cancelDwell, true);
    document.addEventListener('focusin', onDwellFocus, true);
  }

  function stopDwell() {
    cancelDwell();
    document.removeEventListener('pointerover', onDwellOver, true);
    document.removeEventListener('pointerout', cancelDwell, true);
    document.removeEventListener('focusin', onDwellFocus, true);
  }

  // ---------- 生命周期 ----------

  async function start(context) {
    if (!stopped) return; // 已在运行
    ctx = context;
    stopped = false;
    budgetUsed = 0;
    queue.length = 0;
    // 重开时清空记忆：关闭增强会把注入属性整体还原（journal），
    // 若不清空，重新开启时会误以为"已处理"而漏掉这些链接
    seen = new WeakSet();
    processed = new WeakSet();

    await loadConfig();
    if (!aiAvailable) return; // 主开关关闭 → 完全不碰页面

    startDwell();
    await scan();
  }

  function stop() {
    stopped = true;
    queue.length = 0;
    stopDwell();
    ctx = null;
  }

  return {
    start,
    stop,
    observeNew: (els) => {
      if (!stopped) scan(els);
    },
    isRunning: () => !stopped,
  };
})();
