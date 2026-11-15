// WennSicht 内容脚本 —— 页面操作层编排器（BP 2.2）
//
// 生命周期：
//   - 页面加载后读取本站点的记忆状态（ws_active_sites）：此前开启过则自动恢复，
//     否则保持休眠等待快捷键。
//   - 「仅本页」临时模式（SW 经 activeTab 注入并带 ephemeral 标记）不读写记忆，
//     刷新即失效 —— 对应 BP 4.1 三档策略的第一档。
//   - 再次 toggle 则完整还原。
//
// 铁律（BP 第五章）：
//   S1  永远不用正数 tabindex，只允许 0 / -1
//   S3  不覆盖已有语义（各规则模块内部逐条检查）
//   S6  只读不写：不自动点击、不自动提交、不自动填写
//   S8  所有操作在内容脚本隔离世界完成，不向页面主世界注入脚本
//
// 防重复注入：站点级注册、全局注册与 activeTab 注入可能命中同一页面，
// 靠隔离世界的 window 标记只运行一次。因此本文件的规则注册与监听器
// 都必须是幂等的（重复执行时早退）。
(() => {
  // ---------- 会话 69 · 扩展上下文哨兵（真实站点崩溃根因）----------
  // 实证（dev/probe-invalidated-context.mjs，严格对照同一 contextId）：
  //   扩展重载 / CWS 自动更新 / dev watch-reload 后，**长期开着的真实站点标签**
  //   里旧内容脚本的隔离世界还在（window.__WS_LOADED__=true、21 个 WS_* 模块都在），
  //   但 chrome.runtime.id 变 undefined、storage/sendMessage 全抛
  //   "Extension context invalidated." ⇒ 看起来装好了、实际全废；且旧标记拦住重注入。
  //   测试站每次新开页（都在重载之后）⇒ 永远测不到，这就是「测试站正常／真实站大量功能失效」。
  // 对策分三层：
  //   ① 这里：把「上下文是否还活着」作为一等状态，失效时**主动让位**（清 __WS_LOADED__），
  //      让 SW 的自愈重注入能重新初始化；同时给所有 chrome.* 调用加安全包装，
  //      绝不因孤立上下文抛未捕获异常打断整条链。
  //   ② SW：冷启动 / onInstalled(update) 时对已打开标签探测并重注入（见 service-worker.js）。
  //   ③ 各模块：对异常 DOM / 非字符串输入做守护（见 image-pipeline / spa-watcher）。
  const wsRuntimeId = () => {
    try {
      return (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : null;
    } catch { return null; }
  };
  const WS_CTX_ID = wsRuntimeId();
  window.__WS_CTX_ID__ = WS_CTX_ID;
  // 上下文失效（id 丢失）＝ 旧世界已孤立 ⇒ 不认旧的 __WS_LOADED__，允许重新初始化。
  const ctxAlive = !!WS_CTX_ID;
  if (window.__WS_LOADED__ && ctxAlive && window.__WS_CTX_ALIVE__ !== false) return;
  window.__WS_LOADED__ = true;
  window.__WS_CTX_ALIVE__ = ctxAlive;
  window.__WS_CONTEXT_INVALIDATED__ = !ctxAlive;
  // 所有 chrome.* 调用的统一安全包装：孤立上下文里返回安全默认值而不是抛错。
  // 用途是「不让一处 API 失效拖死整条初始化链」；SW 自愈会随后重注入恢复完整能力。
  const safeStorageGet = async (keys, fallback = {}) => {
    try { return await chrome.storage.local.get(keys); } catch { return fallback; }
  };
  const safeStorageSet = async (obj) => {
    try { await chrome.storage.local.set(obj); return true; } catch { return false; }
  };
  const safeSend = (msg, opts) => {
    try {
      const r = chrome.runtime.sendMessage(msg, opts);
      return (r && typeof r.then === 'function') ? r.catch(() => null) : Promise.resolve(r);
    } catch { return Promise.resolve(null); }
  };
  window.__WS_SAFE__ = { storageGet: safeStorageGet, storageSet: safeStorageSet, send: safeSend, alive: ctxAlive };

  // 排除页面完全休眠，连消息监听都不建立。判定模块见 src/data/exclusions.js：
  //   ① 本框架 URL：浏览器内部页面 / 扩展商店 / 银行支付等；
  //   ② 祖先框架：银行（或商店）页里嵌的第三方 iframe 也绝不能初始化——
  //      否则它会在敏感页面语境里跑增强、把内容送进 AI 管线（2026-10-04 补）。
  const wsExclusions = window.WS_EXCLUSIONS;
  if (wsExclusions) {
    const isExcluded = wsExclusions.shouldExcludeUrl
      ? (u) => wsExclusions.shouldExcludeUrl(u)
      : (u) => wsExclusions.isExcluded(u); // 旧注入副本兼容
    if (isExcluded(location.href)) return;
    try {
      const ancestors = location.ancestorOrigins || [];
      for (let i = 0; i < ancestors.length; i++) {
        const origin = ancestors[i];
        // 不透明来源（sandbox / 无来源）没有主机信息，跳过；其余任一祖先命中即休眠
        if (!origin || origin === 'null') continue;
        if (isExcluded(origin)) return;
      }
    } catch {
      // ancestorOrigins 不可用（非浏览器环境）时仅按本框架 URL 判定
    }
  }

  const ORIGIN = location.origin;
  const HIDDEN_ATTR = 'data-ws-hidden';
  // v0.2：注册改为 allFrames:true 后，同源子框架也会跑本脚本。
  // **子框架只做"页面级 DOM 修复"，不播报、不抢焦点、不写存储** ——
  // 否则一个页面有多少框架就有多少份 live region，同一句话被念 N 遍
  //（实测 v2-test.html：顶层与框架各建一个 live region、各播一次"场景解析"，
  //  内容还不一样 → 用户听到的就是"播报全乱 + 重复"）。
  const IS_TOP_FRAME = window.top === window;

  // ---------- 会话 51：区分「普通刷新 / 强制刷新 / 重新打开」 ----------
  // owner 2026-11-07 反馈：Ctrl+R（普通刷新）也会把「修复 N 个标题…」+ 场景解析 +
  // 图片就绪 + 位置恢复句从头再念一遍，打断阅读；只有强制刷新或重开网页才该重播。
  //
  // 判据全部来自浏览器原生 Navigation / Resource Timing（不猜用户环境、不加新权限）：
  //   `dev/_diag-reload.mjs` 用 CDP 实测同一页面三种加载：
  //     navigate(重开)  → type='navigate', deliveryType='',      transferSize≈encodedBodySize
  //     reload(软/Ctrl+R)→ type='reload',   deliveryType='cache', transferSize=300 vs 41133
  //                        且 5/6 个子资源 deliveryType='cache'
  //     reload(硬/Shift) → type='reload',   deliveryType='',      transferSize=41433
  //                        且全部子资源 deliveryType=''（整页重新下载）
  //   ⇒ 只有 type==='reload' 时才判断；「软刷新」需要有**正证据**（主文档来自缓存 /
  //     主文档 304 重验证 / 至少一个子资源来自缓存）。拿不到证据就按「照常播报」处理，
  //     宁可多念一句，也不在信号缺失时擅自静音（与会话 50 的 fail-open 口径一致）。
  //   已知局限：站点全站 `Cache-Control: no-store` 时软刷新也可能没有缓存正证据 ⇒ 会重播；
  //     这是浏览器层面两者行为一致，扩展侧无解，不做二次猜测。
  function readBootNav() {
    try {
      const n = performance.getEntriesByType('navigation')[0];
      if (!n) return { type: 'navigate', soft: false, hard: false, reason: 'no-nav-entry' };
      const type = n.type || 'navigate';
      if (type !== 'reload') return { type, soft: false, hard: false, reason: 'not-reload' };
      const res = performance.getEntriesByType('resource') || [];
      const cacheHits = res.filter((r) => r.deliveryType === 'cache').length;
      const docFromCache = n.deliveryType === 'cache';
      const docRevalidated = n.encodedBodySize > 0 && n.transferSize > 0
        && n.transferSize < n.encodedBodySize * 0.5;
      const soft = docFromCache || docRevalidated || cacheHits > 0;
      return {
        type, soft, hard: !soft,
        deliveryType: n.deliveryType || '', transferSize: n.transferSize,
        encodedBodySize: n.encodedBodySize, cacheHits, resCount: res.length,
        reason: docFromCache ? 'doc-from-cache' : docRevalidated ? 'doc-revalidated'
          : cacheHits > 0 ? 'resources-from-cache' : 'no-cache-evidence',
      };
    } catch {
      return { type: 'navigate', soft: false, hard: false, reason: 'timing-unavailable' };
    }
  }
  const BOOT_NAV = readBootNav();
  // 软刷新：**只静音显式标记 `boot:true` 的页面加载自动播报**。
  // 反过来标记（而不是"静音一切自动播报"）是为了零误伤：问答 / 摘要 / 布局地图 /
  // 悬停重听 / 暂停快捷键反馈 / 表单聚焦 / 错误保底全部不带这个标记，任何情况下都不受影响。
  // **只静音播报，不跳过任何修复 / AI 管线**（DOM 是新建的，必须重跑）。
  // 未标记的开场句只是软刷新时多念一句，不会把用户要的信息吞掉（fail-open）。
  let bootQuiet = IS_TOP_FRAME && BOOT_NAV.soft;
  window.WS_BOOT_NAV = BOOT_NAV; // 诊断 / 回归可直读
  window.WS_BOOT_QUIET = () => bootQuiet;

  // 本帧令牌（2026-11-03 会话 45）：框架级 gather 的 storage.session 键成分，
  // 注入时随机生成、生命周期内稳定——同一帧重复刷新覆盖自己的旧快照，不无限增键。
  const WS_FRAME_TOKEN = Math.random().toString(36).slice(2, 10);

  // 会话 80（真缺陷修复：双内容脚本实例）：journal 与「已登记属性」必须挂在 window 上共享。
  // 实测（demo-site tickets，注入计数=2）：两个实例同时跑规则时，A 写入 role=heading、
  // B 再写一次就记成 had=true（value 是我们的 'heading'）——还原逆序执行时 B 把 role
  // 写回 'heading'，页面关不掉（残留 4/12 个伪标题，逐页随机）。
  // 共享同一个 journal + 同一个 WeakMap 后，同一元素同一属性只会有一条「作者原值」记录。
  const journal = (window.__WS_JOURNAL__ = window.__WS_JOURNAL__ || []);
  const journaledMap = () => (window.__WS_JOURNALED__ || (window.__WS_JOURNALED__ = new WeakMap()));
  let on = false;
  let ephemeral = false; // 「仅本页」模式：不持久化开关状态
  let liveRegion = null;
  // 重复播报同一句话会被吞（2026-10-04 owner 实测：「长描述快捷键很多时候没反应」）：
  // announce 的写入是「先清空、下一帧写文本」两步——当新文本与 region 里**残留的上一条
  // 完全相同**时，清空与写回落在读屏的变更合并窗口内，净变化为零 → Chrome 不派发
  // 变更 → NVDA 不播。连续按同一状态的长描述键（每次都生成一字不差的提示句）、
  // 生成期间连按（每次都是同一句「生成中」）全部静默。修复：交替附加零宽空格，
  // 让每次写入都是真实的文本变化（对语音无影响，零宽字符不发音）。
  let announceFlip = false;

  // ---------- 修改与还原 ----------

  // 统一的属性写入入口：只允许经由此函数修改属性，保证可还原
  function setAttr(el, attr, value) {
    // 会话 80：关闭后的**迟到写入**必须丢弃（异步规则可能晚于 restoreAll 落地）。
    if (!on) return;
    const map = journaledMap();
    let seen = map.get(el);
    if (!seen) { seen = new Set(); map.set(el, seen); }
    if (!seen.has(attr)) {
      journal.push({
        el,
        attr,
        had: el.hasAttribute(attr),
        value: el.getAttribute(attr),
      });
      seen.add(attr);
    }
    el.setAttribute(attr, value);
  }

  // 隐藏元素：内联 display:none !important + 命名空间标记属性。
  // 不用 `hidden` 属性 —— 网站的 `[hidden]{display:block}` 之类规则会覆盖它；
  // 内联 !important 的优先级高于任何作者样式表，能真正生效。
  function hide(el) {
    if (!on) return; // 会话 80：关闭后的迟到隐藏同样丢弃（原因见 setAttr）
    if (el.hasAttribute(HIDDEN_ATTR)) return; // 幂等：已隐藏过
    journal.push({
      el,
      attr: 'style',
      had: el.hasAttribute('style'),
      value: el.getAttribute('style'),
    });
    journal.push({
      el,
      attr: HIDDEN_ATTR,
      had: el.hasAttribute(HIDDEN_ATTR),
      value: el.getAttribute(HIDDEN_ATTR),
    });
    el.style.setProperty('display', 'none', 'important');
    el.setAttribute(HIDDEN_ATTR, '');
  }

  // 一键还原：逆序恢复所有属性（BP 总体原则「刷新页面恢复原状」的内存版）
  // 2026-11-03 会话 45（瀑布流内存）：超长会话的 journal 可能上万条，同步逆序还原
  // 会把主线程卡死数秒——用户按 Ctrl+Shift+Z 后读屏毫无反应。超过 RESTORE_SYNC_MAX
  // 条时改为 requestIdleCallback 分批（每批 RESTORE_BATCH 条，从尾部往前）；调用方
  // await 本函数，「已关闭」播报在还原**完成后**才发（先说关了再慢慢还原会撒谎）。
  const RESTORE_SYNC_MAX = 5000;
  const RESTORE_BATCH = 2000;

  function restoreRecords(from, to) {
    for (let i = to - 1; i >= from; i--) {
      const rec = journal[i];
      if (!rec.el.isConnected) continue;
      if (rec.had) rec.el.setAttribute(rec.attr, rec.value);
      else rec.el.removeAttribute(rec.attr);
    }
  }

  function idleSlice(fn) {
    return new Promise((resolve) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { fn(); resolve(); });
      else setTimeout(() => { fn(); resolve(); }, 0);
    });
  }

  async function restoreAll() {
    // 会话 80：双实例时两个实例都会收到关闭指令——共享 journal 只能被消费一次，
    // 用同一个 window 锁串行；后到者等前一个还原完直接返回。
    if (window.__WS_RESTORE_BUSY__) {
      try { await window.__WS_RESTORE_BUSY__; } catch { /* 前一个失败也视为已尝试 */ }
      return;
    }
    window.__WS_RESTORE_BUSY__ = (async () => {
      const total = journal.length;
      if (total <= RESTORE_SYNC_MAX) {
        restoreRecords(0, total);
        journal.length = 0;
        window.__WS_JOURNALED__ = new WeakMap(); // 新一轮开启重新以作者原值为基准
        return;
      }
      while (journal.length > 0) {
        const end = journal.length;
        const from = Math.max(0, end - RESTORE_BATCH);
        await idleSlice(() => restoreRecords(from, end));
        journal.length = from;
      }
      window.__WS_JOURNALED__ = new WeakMap();
    })();
    try { await window.__WS_RESTORE_BUSY__; } finally { window.__WS_RESTORE_BUSY__ = null; }
  }

  // ---------- 注入自愈抽查（2026-11-03 会话 45） ----------
  // 缺口：框架重渲染可能抹掉我们注入的属性（role/tabindex/aria-level/aria-description/
  // data-ws-btn），而所有 MutationObserver 只监 childList——丢了没人补。
  // 不上属性级 observer（会和自己的写入互相触发、整页开销大），改**定期抽查**：
  // 每 30s 从 journal 抽最近 100 个注入元素，属性被清空的收集起来，按规则分组重跑
  // （headings/interactive 幂等，已带标记的元素内部早退）。每轮最多修 50 个，防雪崩。
  const VERIFY_ATTRS = new Set(['role', 'tabindex', 'aria-level', 'aria-description', 'aria-label', 'data-ws-btn', 'scope']);
  const VERIFY_INTERVAL_MS = 30000;
  const VERIFY_SAMPLE = 100;
  const VERIFY_FIX_MAX = 50;
  let verifyTimer = null;

  function verifyInjections() {
    const rules = window.WS_RULES || {};
    if (typeof rules.headings !== 'function' && typeof rules.interactive !== 'function') return;
    const checked = new Set();
    const missing = [];
    for (let i = journal.length - 1; i >= 0 && checked.size < VERIFY_SAMPLE && missing.length < VERIFY_FIX_MAX; i--) {
      const rec = journal[i];
      if (!VERIFY_ATTRS.has(rec.attr) || checked.has(rec.el)) continue;
      checked.add(rec.el);
      let cur = null;
      try {
        cur = rec.el.getAttribute(rec.attr);
      } catch {
        continue; // 元素已断开：无从修复也不算缺失
      }
      // 我们的注入值都是非空字符串；属性被框架抹掉后 getAttribute 回 null ⇒ 判缺失
      if (!cur) missing.push(rec.el);
    }
    if (!missing.length) return;
    const c = buildCtx();
    try {
      if (typeof rules.headings === 'function') rules.headings(c, missing);
    } catch { /* 单规则失败不影响另一条 */ }
    try {
      if (typeof rules.interactive === 'function') rules.interactive(c, missing);
    } catch { /* 同上 */ }
  }

  function startInjectionVerify() {
    if (verifyTimer || !IS_TOP_FRAME) return;
    verifyTimer = setInterval(() => {
      try {
        verifyInjections();
      } catch {
        /* 抽查失败不影响既有修复 */
      }
    }, VERIFY_INTERVAL_MS);
  }

  function stopInjectionVerify() {
    if (verifyTimer) {
      clearInterval(verifyTimer);
      verifyTimer = null;
    }
  }

  // ---------- 状态播报 ----------

  // 唯一的 live region。默认 polite（BP 4.5：不抢焦点、不打断朗读）。
  //
  // opts.urgent=true：极少数「错过就出事」的消息（表单错误提示）例外——临时把**同一个**
  // region 切成 assertive，让读屏当场打断读出来。2026-10-03 owner 二轮回听定案：NVDA 对
  // polite 只是排队，而**下一次焦点事件会把排队整个清掉**——错误字段的焦点朗读最长
  //（名字 + 「错误的输入」+ 已填值，约 3 秒），用户 Tab 走时排队中的错误提示必被丢弃
  //（CDP 实证两条提示都写进了 region，耳朵却只听到不带错误那条）。错误信息又必须被听到，
  // 而给字段挂 aria-describedby 违反 BP 4.2「不触碰表单元素」——打断是唯一出路，
  // 且仍是同一个 region、同一个播报源（不建第二 region）。
  // 写完约 700ms 后自动恢复 polite：足够读屏取到 assertiveness，又不误伤紧随其后的普通提示。
  const URGENT_RESTORE_MS = 700;
  let urgentRestoreTimer = null;

  function restorePoliteSoon() {
    if (urgentRestoreTimer) return;
    urgentRestoreTimer = setTimeout(() => {
      urgentRestoreTimer = null;
      if (liveRegion?.isConnected) liveRegion.setAttribute('aria-live', 'polite');
    }, URGENT_RESTORE_MS);
  }

  // 每条消息写入前先定调门（同一 region 的唯一属性切换点）
  function setLivePoliteness(urgent) {
    if (urgentRestoreTimer) { clearTimeout(urgentRestoreTimer); urgentRestoreTimer = null; }
    if (!liveRegion) return;
    liveRegion.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
    if (urgent) restorePoliteSoon();
  }

  // 长播报保护（2026-11-06 · owner：摘要读几秒就断）
  //
  // 现场取证（dev/_probe-summary-cut.mjs）：摘要文本**只写入一次**，之后没有其他写入——
  // 所以“被后一句顶掉”在干净页上不是主因。但真实站点不同：图片管线批次句
  // （“图片描述已就绪（N 张）”）常在激活后 ~2 秒落地，它会直接替换 region 文本，
  // 读屏当场切到新消息，长文只听得到前两秒。故：摘要（opts.protect=true）写完后开一个
  // “朗读窗口”，窗口内**其他模块的播报排队**而不是覆盖（只保留最新一条，窗口结束后再播）。
  // ⚠️ 只给摘要开窗口：任何长文本都开会误伤别的功能（布局地图 130 字就能把长描述静音
  // 几十秒，verify-v10 6 红）。用户主动触发（source:'user'）/ urgent 的播报一律立即让路。
  const SPEAK_MS_PER_CHAR = 160; // 每字 160ms 的保守估计（比正常语速慢，宁可多等一会儿）
  let speakUntil = 0;
  let deferred = null;
  let deferTimer = null;

  function speakWindow(text) {
    const ms = Math.min(String(text).length * SPEAK_MS_PER_CHAR, 90000);
    speakUntil = Date.now() + ms;
  }

  function flushDeferred() {
    deferTimer = null;
    const d = deferred;
    deferred = null;
    if (!d) return;
    const wait = speakUntil - Date.now();
    if (wait > 0) {
      deferred = d;
      deferTimer = setTimeout(flushDeferred, wait + 30);
      return;
    }
    announce(d.text, d.opts);
  }

  // 单次 characterData 写入：旧实现先 `textContent=''` 再写，等于额外发一条
  // 「区域被清空」的无障碍事件——读屏可能把它当新消息处理，把正在朗读的长文本掐掉。
  // 保持同一个文本节点改 data，只有一次变更事件。
  function writeLive(region, payload) {
    let node = region.firstChild;
    if (!node || node.nodeType !== 3) {
      region.textContent = '';
      node = document.createTextNode('');
      region.appendChild(node);
    }
    node.data = payload;
  }

  function announce(text, opts = {}) {
    if (!IS_TOP_FRAME) return; // 子框架不播报（见 IS_TOP_FRAME 注释）
    if (!document.body) return;
    // 会话 51：普通刷新不再重播开场串。只吞「页面加载自动」的那一批（显式 boot:true）；
    // 用户主动要的播报、开关反馈、错误保底一律不带该标记，永不误伤。
    if (bootQuiet && opts.boot === true) return;
    // 长文正在朗读：后台播报排队（用户主动触发的播报、urgent 例外）。
    // 会话 68「覆盖度诚实」铁律：披露句（opts.coverage）**不得被 speakUntil 无限期推迟**
    // —— 摘要最长可开 90s 朗读窗口，排队会让「只描述了前 10 张」等句子迟到甚至被
    // 后续 deferred 顶掉（deferred 只保留最新一条）。故对 coverage 放行，仍保持 polite。
    if (opts.source !== 'user' && opts.urgent !== true && opts.coverage !== true && Date.now() < speakUntil) {
      deferred = { text, opts };
      if (!deferTimer) deferTimer = setTimeout(flushDeferred, Math.max(0, speakUntil - Date.now()) + 30);
      return;
    }
    // 诊断探针：最近播报过的句子（最多 50 条）。用途只有一个——回归里判断
    // 「有没有闪一下又关回去」（live region 只留最后一句，看不出中途说过什么）。
    // 与 __WS_GATE__ / __WS_ON__ 同性质：只记扩展自己说的话，不碰页面内容。
    try {
      const said = (window.__WS_SAID__ = window.__WS_SAID__ || []);
      said.push(String(text));
      if (said.length > 50) said.shift();
    } catch { /* 忽略 */ }
    const urgent = opts && opts.urgent === true;
    let created = false;
    if (!liveRegion || !liveRegion.isConnected) {
      if (urgentRestoreTimer) { clearTimeout(urgentRestoreTimer); urgentRestoreTimer = null; }
      liveRegion = document.createElement('div');
      liveRegion.setAttribute('role', 'status');
      liveRegion.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
      // 增量扫描跳过自身注入物（spa-watcher 依据此标记）
      liveRegion.setAttribute('data-ws-ignore-obs', '');
      liveRegion.style.cssText =
        'position:absolute;width:1px;height:1px;margin:-1px;border:0;padding:0;' +
        'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
      document.body.appendChild(liveRegion);
      created = true;
      if (urgent) restorePoliteSoon(); // 新建时文本等 150ms 挂钩后才写，恢复窗口仍有余量
    } else {
      setLivePoliteness(urgent);
    }
    const region = liveRegion;
    // 交替附加零宽空格（见 announceFlip 注释）：保证与 region 残留文本必然不同
    announceFlip = !announceFlip;
    const payload = announceFlip ? text : text + '\u200b';
    // 2026-11-06 会话 48 修正：**只有显式 protect 的长文本**才开朗读窗口。
    // 旧版「任何 ≥120 字」都开窗口 ⇒ 布局地图那句 130 字的播报会把随后所有长描述播报
    // 排队几十秒（verify-v10 当场 6 红，读到的永远还是地图那句）。保护是为了摘要
    //（owner 报「摘要读几秒就断」），不该顺手把别的功能一起静音。
    if (opts.protect === true && String(text).length >= 120) speakWindow(text);
    if (created) {
      // 屏幕阅读器需要时间挂钩新建的 live region：新建后立即写文本，变更事件会被
      // 整个吞掉（实测：关闭增强后 region 被移除，重新开启的「已开启」提示丢失）。
      // 新建时给 ~150ms 挂钩时间再写；已存在的 region 立即写（保持关闭提示的即时性）。
      setTimeout(() => writeLive(region, payload), 150);
    } else {
      requestAnimationFrame(() => writeLive(region, payload));
    }
  }

  // 播报完成后移除 live region，避免关闭增强后残留注入物
  function disposeLiveRegionSoon() {
    setTimeout(() => {
      if (on || !liveRegion) return; // 期间又开启了则保留
      if (liveRegion.isConnected) liveRegion.remove();
      liveRegion = null;
    }, 2000);
  }

  // ---------- 敏感站点默认关闭闸门（2026-10-25 · owner SOLE_TRUTH 定案）----------
  // 判定在 ai-privacy.js 的 gateBlocked 注释里（一句话）：**敏感 && 用户没点名过这个站
  // ⇒ 默认整页不处理**。「点名过」= 他自己开启过（`ws_active_sites[origin] === true`）
  // 或此前强制开启过（`forceEnhance`）；**全局启用不算点名**。
  //
  // 手势：**把 Ctrl+Shift+Z 连按两次**（owner 原话「ctrl shift z z」）。
  //   · 第一次 → 只说一句「要强制开启，请再按一次 Ctrl+Shift+Z」，**不开**；
  //   · 第二次（同一个组合键）→ 强制开启 + 落 `forceEnhance` + 加入常用站点列表。
  //   · **第一次不被刷新影响**（owner 2026-10-25 明确要求）：按键计数落 storage
  //     （`ws_sensitive_armed[origin]`），刷新 / 内容脚本重注入后仍然算数；窗口 30 秒。
  //   · 容忍乱按：窗口内按 3 下、4 下都算同一次手势；开启后有 2.5 秒尾巴吞掉余键，
  //     避免「连按四下 ⇒ 开→关→开」的闪烁。
  //   · **单独的字母 Z（无 Ctrl/Shift）永远不算**（owner：「不存在按一下 z 就好了」）。
  // 命中后**不再播报敏感**（情形 ③⑤：正常运行、不播报敏感）——这是 SOLE_TRUTH 的明确要求。
  // ⚠️ 2026-10-31（owner 实测）：「Ctrl+Shift+Z Z」读屏会念成「ctrl shift z z」——听着像要按字母 Z。
  // 手势名只写组合键本身，动作另用一个词说清楚：「连按两次 Ctrl+Shift+Z」。
  // 会话 74（owner）：播报里不许写死 Ctrl+Shift+Z —— 手势名跟用户实际绑定的组合键走。
  // 取不到时退回 manifest 默认值，保证任何情况下都有话可说。
  const toggleKey = () => window.WS_SHORTCUT?.toggle?.() || 'Ctrl+Shift+Z';
  const forceGestureText = () => window.WS_SHORTCUT?.forceText?.() || `连按两次 ${toggleKey()}`;
  const GESTURE_ARM_MS = 30000; // 手势容忍窗：第一次之后等第二下的时间
  const GESTURE_TAIL_MS = 2500; // 手势尾巴：这期间的按键全部吞掉
  const ARM_KEY = 'ws_sensitive_armed'; // { [origin]: { at, count } } —— 刷新也要记得的「第一次」
  let pressWindowStart = 0;
  let pressCount = 0; // 容忍窗内按了几次（≥2 才算手势成立）
  let absorbUntil = 0; // >now 表示处于手势尾巴，忽略按键
  let gateLabelForConfirm = '';
  let armLoaded = null;

  // 首次用到时把「上次（可能是刷新前）的按键计数」读回来
  function loadArmOnce() {
    if (!armLoaded) {
      armLoaded = (async () => {
        try {
          const stored = await chrome.storage.local.get(ARM_KEY);
          const r = (stored[ARM_KEY] || {})[ORIGIN];
          if (r && Number.isFinite(r.at) && Date.now() - r.at <= GESTURE_ARM_MS) {
            pressWindowStart = r.at;
            pressCount = Math.max(1, Number(r.count) || 1);
          }
        } catch {
          /* 读不到就当没按过 */
        }
      })();
    }
    return armLoaded;
  }

  // 记一次手势按键（**唯一来源 = 命令通道**，一个物理按键只会来一次）
  async function noteGesturePress(label) {
    await loadArmOnce();
    const now = Date.now();
    if (label) gateLabelForConfirm = label;
    if (!pressWindowStart || now - pressWindowStart > GESTURE_ARM_MS) {
      pressWindowStart = now;
      pressCount = 0;
    }
    pressCount += 1;
    try {
      // 落盘：刷新之后这一下仍然算数（owner 2026-10-25：「第一次不被刷新影响」）
      const stored = await chrome.storage.local.get(ARM_KEY);
      const map = stored[ARM_KEY] || {};
      map[ORIGIN] = { at: pressWindowStart, count: pressCount };
      await chrome.storage.local.set({ [ARM_KEY]: map });
    } catch {
      /* 落盘失败：本次仍按内存计数生效 */
    }
    return pressCount;
  }

  // 手势兑现 / 关掉增强 → 把「第一次」清干净，避免下次单击就被当成第二下
  async function clearArm() {
    pressWindowStart = 0;
    pressCount = 0;
    try {
      const stored = await chrome.storage.local.get(ARM_KEY);
      const map = stored[ARM_KEY] || {};
      if (map[ORIGIN]) {
        delete map[ORIGIN];
        await chrome.storage.local.set({ [ARM_KEY]: map });
      }
    } catch {
      /* 忽略 */
    }
  }

  const sensitiveClassText = (label) => (label ? `${label}类敏感站点` : '敏感站点');

  // 加载时 / 第一次按快捷键：说明默认关闭 + 说清怎么强制开启（只说手势名）
  function gateHint(label) {
    return `本站属于${sensitiveClassText(label)}，无障碍增强默认关闭。需要时${forceGestureText()} 即可强制开启。`;
  }

  // 已按过一次：说「再按一次」（owner 2026-10-25 原话），不再重复整个手势名两遍
  function gateConfirmHint(label) {
    return `本站属于${sensitiveClassText(label)}，增强默认关闭。要强制开启，请再按一次 ${toggleKey()}。`;
  }

  // 按了「别的」快捷键（摘要/问答/长描述/布局地图/暂停/反馈）：只指路，不代劳
  function gateOtherHint(label) {
    return `本站属于${sensitiveClassText(label)}，无障碍增强默认关闭。请先${forceGestureText()} 强制开启，再用这个快捷键。`;
  }

  // 「还没开启增强」的统一提示（2026-11-03 owner 报障）：
  //   owner 原话「公益中转下还是一直说没有开启增强」——他把设置页的「开启智能」（AI 主开关）
  //   当成了增强开关。实际是两层：**增强按站点/全局生效**，AI 只是增强里的一层能力。
  //   ephemeral = SW 用 activeTab 临时注入（该站没加进列表、也没开全局）⇒ 这一次开启
  //   刷新就没了。不明说的话，用户会一直重复「按一次 → 换页又没了」。
  function notEnabledHint(what) {
    const base = `请先按 ${toggleKey()} 开启无障碍增强，再使用${what}。`;
    return ephemeral
      ? `${base}这种开启只对本次打开有效；想每个网站自动开启，请在设置页勾选「全局启用」。`
      : base;
  }

  // 读闸门判定（要读存储里的 forceEnhance，故 async）。判定失败按「拦下」处理：
  // 宁可少做，也不在不确定是否敏感的页面上擅自改写（隐私侧从严）。
  async function readGate() {
    const P = window.WS_AI_PRIVACY;
    if (!P?.init) return { blocked: false, label: '', sensitive: false, forced: false }; // 旧注入副本：保持原行为
    let out;
    try {
      await P.init();
      out = {
        blocked: !!P.gateBlocked?.(),
        label: P.label?.() || '',
        sensitive: !!P.category?.(),
        forced: !!P.forced?.(),
      };
    } catch (err) {
      console.warn('[WennSicht] 敏感站点判定失败：', err);
      out = { blocked: true, label: '', sensitive: true, forced: false };
    }
    // 取证/诊断探针（与 __WS_APPLY_FAILED__ 同一性质：只读状态，无副作用）
    window.__WS_GATE__ = {
      ...out,
      category: P.category?.() || null,
      optedIn: !!P.optedIn?.(),
      globalMode: !!P.globalMode?.(),
      at: Date.now(),
    };
    return out;
  }

  // 用户在本页手动开启 ⇒ 把「这个站点我要用」记到设置里（情形 ⑥⑦「添加到开启列表」）。
  // 逐站模式下 SW 会写 ws_sites + ws_active_sites 并注册内容脚本；全局模式下 SW 直接返回 added:false。
  async function persistExplicitEnable() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'WS_PERSIST_SITE', origin: ORIGIN });
      return !!r?.added;
    } catch {
      return false; // SW 不在/被拒绝：不影响本次开启
    }
  }

  // 强制开启（第二次 Ctrl+Shift+Z）：落盘后走正常开启流程。
  // 按 SOLE_TRUTH，用户点名过之后这个站就是「正常站点」——**不再播报敏感**。
  async function forceEnableEnhance() {
    absorbUntil = Date.now() + GESTURE_TAIL_MS; // 开启后的连按都归入同一次手势
    await clearArm();
    try {
      await window.WS_AI_PRIVACY?.forceEnhance?.();
    } catch (err) {
      console.warn('[WennSicht] 强制开启未能写入设置（本次仍生效，下次打开不会记住）：', err);
    }
    await persistExplicitEnable(); // 情形 ②③ 也让它进「添加站点」列表，设置页一眼能看到
    if (on) {
      announce('无障碍增强已开启');
      return;
    }
    on = true;
    await syncSwitch({ focus: true, forcedOpen: true });
    chrome.runtime.sendMessage({ type: 'WS_BROADCAST_STATE', on: true }).catch(() => {});
  }

  // ---------- 「播报插件改了什么」总开关（2026-10-31 · owner 要求）----------
  // 设置页「四、浏览体验 → 播报增强做了什么」。**默认开**。
  // 关掉后：只说「无障碍增强已开启」，不再逐项报告「修复 3 个标题 / 补出 4 个地标 / 隐藏 2 个噪音块」，
  // 图片管线的「已为 N 张图片生成…」统计也一并静音（见 image-pipeline 的 verboseChanges）。
  // **仍然照播**：出错、图片无法加载、验证码这类需要用户知道的句子——别把「噪音控制」做成「坏了也不说」。
  let announceChanges = true;
  const announcePrefReady = (async () => {
    try {
      const { ws_ui_config = {} } = await chrome.storage.local.get('ws_ui_config');
      announceChanges = ws_ui_config.announceChanges !== false;
    } catch {
      /* 读不到按默认开 */
    }
    window.WS_VERBOSE_CHANGES = announceChanges;
  })();
  try {
    // 设置页改完立刻生效（不用刷新页面）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.ws_ui_config) return;
      announceChanges = changes.ws_ui_config.newValue?.announceChanges !== false;
      window.WS_VERBOSE_CHANGES = announceChanges;
    });
  } catch {
    /* 旧环境没有 onChanged：保持默认 */
  }

  // ---------- 增强自检（v0.2）：让用户知道插件到底做了什么 ----------
  // 盲用户看不见页面变化，没有反馈就无法判断增强是否真的生效、动了哪些东西
  // （这也是 overlay 类产品引发信任危机的根源——"页面被第三方改了却不知道"）。
  // 只统计「规则层」：图片描述由图片管线自己异步播报（此处还来不及生成），
  // 链接意图等异步模块同理不计入。计数读 journal 当前属性值，还原时清空，天然一致。
  const LANDMARK_ROLES = new Set(['navigation', 'search', 'main', 'contentinfo']);

  function summarizeChanges() {
    const hidden = new Set();
    const headings = new Set();
    const buttons = new Set();
    const landmarks = new Set();
    const headers = new Set();
    let langFixed = false;
    for (const rec of journal) {
      let now = null;
      try {
        now = rec.el.getAttribute(rec.attr);
      } catch {
        continue;
      }
      if (rec.attr === HIDDEN_ATTR) {
        hidden.add(rec.el);
      } else if (rec.attr === 'lang') {
        if (now) langFixed = true;
      } else if (rec.attr === 'role') {
        if (now === 'heading') headings.add(rec.el);
        else if (now === 'button') buttons.add(rec.el);
        else if (LANDMARK_ROLES.has(now)) landmarks.add(rec.el);
        else if (now === 'columnheader') headers.add(rec.el);
      } else if (rec.attr === 'scope') {
        headers.add(rec.el);
      }
    }
    const parts = [];
    if (langFixed) parts.push('补上页面语言标注');
    if (headings.size) parts.push(`修复 ${headings.size} 个标题`);
    if (buttons.size) parts.push(`补充 ${buttons.size} 个按钮语义`);
    if (landmarks.size) parts.push(`补出 ${landmarks.size} 个区块地标`);
    if (headers.size) parts.push(`补全 ${headers.size} 个表头单元格`);
    if (hidden.size) parts.push(`隐藏 ${hidden.size} 个噪音块`);
    // 同意弹窗刻意不隐藏（藏了遮罩还在，用户更惨）——只提示用户自行处理
    const consent = Number(window.WS_STATS?.consentOverlays) || 0;
    if (consent) parts.push(`发现 ${consent} 个同意弹窗（未隐藏，需要你处理）`);
    return parts;
  }

  // 开启播报：有改动才附自检结果；页面本就干净时保持原句（不制造噪音）
  // 2026-10-31：设置页关掉「播报增强做了什么」后**只报状态**，不再逐项列举改了哪些内容。
  function openedMessage() {
    if (!announceChanges) return '无障碍增强已开启';
    const parts = summarizeChanges();
    return parts.length ? `无障碍增强已开启：${parts.join('、')}。` : '无障碍增强已开启';
  }

  // 逐句拼接（每句以句号收尾）。**空附加项时逐字保持原句**——
  // 「页面本就干净时保持原句」是既有断言钉死的行为，不能因为拼接而改变。
  function joinSentences(base, extras) {
    const parts = extras.filter(Boolean);
    if (!parts.length) return base;
    return [base, ...parts]
      .map((p) => (/[。！？]$/.test(p) ? p : p + '。'))
      .join('');
  }

  // v0.2 第 8 项：敏感站点（政务/医疗/金融）隐私提示；非敏感站或已放行时为空串
  function privacyNotice() {
    return window.WS_AI_PRIVACY?.notice?.() || '';
  }

  // ---------- 工具 ----------

  // 分批处理 DOM，避免阻塞主线程与屏幕阅读器（技能规则 6 / BP「不阻塞屏幕阅读器」）
  // ⚠️ 会话 70（owner：「不能因为网站体量而延迟播报」）：旧实现是**固定每帧 20 个节点**，
  //    于是耗时与节点数成正比：15.9k 节点的维基百科要 750 帧 ≈ 5.7s 才轮到播报
  //    「无障碍增强已开启」。改为**时间预算式**：每帧只占 ~8ms，能干多少干多少。
  //    同一帧内多处理的元素数随单元素耗时自适应（小的多干，大的少干），既保持
  //    「不阻塞读屏」（每帧让出，最坏也是 8ms）又让体量不再线性拖慢开启播报。
  // 会话 70：**后台/隐藏标签页里 requestAnimationFrame 根本不触发**——若只用 rAF 让路，
  // 批量处理（含「关闭增强」的还原链）在用户切走的标签页上会永久挂住（真机探针复现：
  // evaluate 超时 → 会话丢失）。加 50ms 定时器兜底：能等帧就等帧（普通前台行为不变），
  // 拿不到帧就按时间片继续，永不挂死。
  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        requestAnimationFrame(fin);
      } catch {
        fin();
        return;
      }
      setTimeout(fin, 50);
    });
  }

  async function forEachBatched(nodes, fn) {
    const arr = Array.from(nodes);
    const FRAME_BUDGET_MS = 8;
    let i = 0;
    while (i < arr.length) {
      await nextFrame();
      const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + FRAME_BUDGET_MS;
      while (i < arr.length) {
        try {
          fn(arr[i]);
        } catch {
          // 单个元素失败不影响整体
        }
        i++;
        if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) >= deadline) break;
      }
    }
  }

  // 大模型调用客户端（开发者接口）：经 Service Worker 路由到已配置的
  // provider（见 src/services/ai.js）。规则模块通过 ctx.ai.chat() 调用。
  // 用法：const res = await ctx.ai.chat([{ role: 'user', content: '你好' }]);
  const aiClient = {
    // v0.2 第 8 项：敏感站点（政务/医疗/金融）默认不放行 AI——兜底闸门，
    // 即使某个模块漏检也会在这里被拦下（各模块另有 aiAvailable 级别的早退，保证静默、不误报失败）
    assertAllowed() {
      if (window.WS_AI_PRIVACY?.allowed?.() === false) {
        throw new Error('本站点属敏感类别，智能功能已按隐私保护暂停');
      }
    },
    async chat(messages, options) {
      aiClient.assertAllowed();
      const res = await chrome.runtime.sendMessage({
        type: 'WS_AI_CHAT',
        messages,
        options,
      });
      if (!res?.ok) throw new Error(res?.error || 'AI 调用失败');
      return res; // { ok, text, model, provider }
    },
    // 图片描述：字节由 Service Worker 侧获取（绕过页面 CORS），此处只传地址；
    // 画布型图表传 dataUrl（内容脚本已渲染好的画面），kind: 'chart' 走图表专用提示词
    async describeImage({ url, dataUrl, context, kind }) {
      aiClient.assertAllowed();
      const res = await chrome.runtime.sendMessage({
        type: 'WS_DESCRIBE_IMAGE',
        url,
        dataUrl,
        context,
        kind,
      });
      if (!res?.ok) throw new Error(res?.error || '图片描述失败');
      return res; // { ok, description, confident }
    },
  };

  // ---------- 规则执行 ----------

  // BP 4.2 执行顺序：先噪音清理，再标题层级，再交互语义
  async function applyAll() {
    const ctx = buildCtx();
    // v0.2 第 8 项：先做敏感站点判定（纯本地、零网络），后面的 AI 能力据此门控；
    // 必须在 pipeline.start()/scene.run() 之前完成，否则会出现「先发出一枪再上锁」。
    // ⚠️ 隐私侧仍 fail-open 不可接受：ai-privacy 的 allowed 初值是 true，若 init 抛错
    //    却继续往下跑，AI 会在敏感站上**无门控**运行 ⇒ 隐私事故。
    // 会话 69 修订：**不再让这一步抛错把整条链拖死**（真实站孤立上下文时 init 必抛
    //    "Extension context invalidated"，旧实现 ⇒ 全部能力都不初始化，正是 owner 报的
    //    「大量功能无法使用」）。改为：init 失败时**只**在隐私侧 fail-closed
    //    （把 WS_AI_PRIVACY 标记为不允许 AI），本地规则照常逐条独立兜底继续跑。
    //    这样既不 fail-open，也不因单点 API 失效让整页残废。
    try {
      await window.WS_AI_PRIVACY?.init?.();
    } catch (err) {
      window.__WS_PRIVACY_INIT_FAILED__ = String(err?.message || err || 'unknown');
      try {
        // 没有可用的门控模块时，用一个最小替身把所有 AI 调用挡住（assertAllowed 读它）。
        if (!window.WS_AI_PRIVACY || typeof window.WS_AI_PRIVACY.allowed !== 'function') {
          window.WS_AI_PRIVACY = { allowed: () => false, init: async () => ({}) };
        } else {
          const P = window.WS_AI_PRIVACY;
          const origAllowed = P.allowed;
          P.allowed = () => {
            try { return origAllowed.call(P) === true; } catch { return false; }
          };
          // 上下文失效 ⇒ 一律按「不允许外发」处理（隐私从严）
          if (!ctxAlive) P.allowed = () => false;
        }
      } catch { /* 连替身都装不上时，下面的 AI 调用会在 sendMessage 里安全失败 */ }
      console.warn('[WennSicht] 隐私门控初始化失败（AI 已按敏感站处理，本地规则继续）:', err?.message || err);
    }
    // —— 以下每一步单独兜底（2026-10-12 加固）——
    // 旧实现是一条**无隔离**的 await 链：任一能力在怪异站点上初始化失败，它之后的全部
    // 能力都**静默不再初始化**（例：chart-table 一抛错 → 表格解析 / 表单辅助 / 长描述 /
    // 布局地图 / 实时播报 / 模态守护 全都不装），用户只得到「半增强」页面且毫无反馈。
    // 与「停机步骤逐个独立兜底」（runSwitch 的 else 分支，2026-10-02 实测缺陷）同一原则：
    // 「一键还原页面」不能被任何一步拖死，「一键增强页面」同样不能。
    const failedSteps = [];
    // 会话 70：「不能因为网站体量而延迟播报」需要可量化——每步记耗时，暴露成
    // `window.__WS_STEP_MS__`（与 `__WS_APPLY_FAILED__` 同性质：只记扩展自己说的话）。
    // 真站（15.9k 节点的维基）定位到具体哪条规则在吃掉秒级时间。
    const stepMs = {};
    window.__WS_STEP_MS__ = stepMs;
    const warnStep = (name, err) => {
      failedSteps.push(name);
      console.warn('[WennSicht] 能力初始化失败（已跳过该项，其余照常）：', name, err?.message || err);
    };
    // 语义与原 `await x.start()` 完全一致（会等待）
    const awaitStep = async (name, fn) => {
      const t = performance.now();
      try { await fn(); } catch (err) { warnStep(name, err); } finally { stepMs[name] = Math.round(performance.now() - t); }
    };
    // 语义与原 `x.start()` 完全一致（不等待；若返回 Promise 仅补 catch，防未处理拒绝）
    const fireStep = (name, fn) => {
      try {
        const r = fn();
        if (r && typeof r.then === 'function') r.catch((err) => warnStep(name, err));
      } catch (err) { warnStep(name, err); }
    };
    const rules = window.WS_RULES || {};
    // lang 适配放最前：文档语言先于一切内容修复，屏幕阅读器的语音选择
    // 依赖它（无 lang 页面在「自动切换语言」下会用错嗓音甚至静音）
    await awaitStep('rules.langFix', () => (typeof rules.langFix === 'function' ? rules.langFix(ctx) : null));
    // landmarks 放最后：它依赖前面几步的结果（被隐藏的噪音不再参与判定，
    // 标注出的标题能帮助识别主内容容器）
    for (const name of ['noise', 'headings', 'headingHierarchy', 'interactive', 'landmarks']) {
      await awaitStep('rules.' + name, () => (typeof rules[name] === 'function' ? rules[name](ctx) : null));
    }
    // v0.2：把 headings/interactive 跑进 open shadowRoot（Web Components 站点）
    fireStep('shadow', () => window.WS_SHADOW?.start(ctx));
    // 规则修复完成后再启动图片队列（BP 4.3：先让屏幕阅读器可读原有内容）
    await awaitStep('pipeline', () => window.WS_IMAGE_PIPELINE?.start(ctx));
    // P1：模糊链接意图补充（BP P1）——异步增值能力，不阻塞上面的修复
    await awaitStep('linkIntent', () => window.WS_LINK_INTENT?.start(ctx));
    // P1：图表描述/转表格（BP P1）——画布型走视觉模型（只报类型/轴/趋势）
    await awaitStep('chartTable', () => window.WS_CHART_TABLE?.start(ctx));
    // P2：表格解析（BP P2）——无表头语义的复杂表格补列头角色 + 结构描述（零 AI）
    await awaitStep('tableParser', () => window.WS_TABLE_PARSER?.start(ctx));
    // P2：表单辅助（BP P2）——无标签输入框聚焦时播报本地推断（只读不写，零 AI）
    fireStep('formHelper', () => window.WS_FORM_HELPER?.start(ctx));
    // v0.2 第 10 项：长描述 / 布局地图接线（消息触发型，启动即 attach；动态播报默认关、
    // 站点级开——start 内部读 ws_live_sites，未开启不挂观察器）
    fireStep('imageLongdesc', () => window.WS_IMAGE_LONGDESC?.attach(ctx));
    fireStep('layoutMap', () => window.WS_LAYOUT_MAP?.attach(ctx));
    fireStep('liveUpdates', () => window.WS_LIVE_UPDATES?.start(ctx));
    // v0.2 第 3 项补完：弹窗出现时把焦点送进去（Tab/b 不再从弹窗跳到背景）
    fireStep('modalWatcher', () => startModalWatcher());
    // 供回归验证（纯本地、零 AI）：本次未装上的能力名清单（空数组 = 全部就位）
    window.__WS_APPLY_FAILED__ = failedSteps;
    return { failedSteps };
  }

  // 模态根（v0.2 第 3 项）：网站打开弹窗时，给背景元素补 role/tabindex 会破坏
  // 网站自己的焦点陷阱（技术背调 2.2.2）——用户按 Tab 会从弹窗里跑出去、迷失在背景。
  // 本函数给出「当前真正打开的模态容器」，规则据此把注入限制在模态内部。
  // 判定从严：必须可见且有实际尺寸（模板里的隐藏 dialog 不算打开）。
  function findModalRoot() {
    let found = null;
    let list;
    try {
      list = document.querySelectorAll(
        '[aria-modal="true"], dialog[open], [role="dialog"], [role="alertdialog"]'
      );
    } catch {
      return null;
    }
    for (const el of list) {
      try {
        // 扩展自管的对话框（如长描述的选图对话框）自己承担焦点契约——打开时初始焦点、
        // Tab 环绕、关闭时把焦点交接给隐藏落点，且**刻意不归还打开前焦点**。
        // site-modal 看护必须整体绕开它们，否则两条都在关闭路径上帮倒忙（2026-10-11 取证）：
        //   ① 焦点陷阱会把刚交接出去的焦点立刻拉回对话框内的按钮（交接无声失效）；
        //   ② 弹窗消失那轮把焦点还原到「打开前的页面元素」→ 读屏重读文档 + 当前行，
        //      正是 owner 实测「长描述之前又念一遍页面图片」的来源之一。
        if (el.closest('[data-ws-modal-self]')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) continue;
      } catch {
        continue;
      }
      found = el; // 取最后一个可见的（后打开的通常在 DOM 末尾）
    }
    return found;
  }

  // 模态焦点管理（v0.2 第 3 项补完，2026-10-01 owner 实测反馈）：
  // 光「不再给背景补 tabindex」不够——弹窗打开时页面焦点还停在触发按钮（背景），
  // NVDA 的浏览光标也跟着留在背景：按 Tab/b 仍然「跳到背景」。真实弹窗应自己
  // 把焦点移进去，但中文站普遍不做；这里补上标准 ARIA 对话框行为：
  //   弹窗出现 → 焦点移入弹窗第一个可聚焦元素（或弹窗本身 tabindex=-1）；
  //   弹窗消失 → 焦点还给打开前的元素。
  // S6 合规：这是焦点导航（等同用户按 Tab），不是点击/提交/填值。
  let modalWatcher = null;
  let lastModal = null;
  let modalReturnFocus = null;
  let modalCheck = null;
  let modalTrap = null;
  let modalTrapKey = null;
  // 伪按钮键盘激活监听（2026-11-03 会话 45，随增强启停）
  let wsBtnActivate = null;
  let modalProgramming = false; // 程序化焦点移动标记（陷阱不能拦自己）
  let modalLastInside = null; // 弹窗内最后聚焦的元素（Shift+Tab 溢出时回到它，而不是第一个）
  function focusablesIn(modal) {
    const list = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    return [...list].filter((el) => {
      try {
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
      } catch {
        return false;
      }
    });
  }
  function firstFocusableIn(modal) {
    return focusablesIn(modal)[0];
  }
  function startModalWatcher() {
    if (modalWatcher || !IS_TOP_FRAME) return;
    lastModal = null;
    modalReturnFocus = null;
    const check = () => {
      try {
        const modal = findModalRoot();
        if (modal && modal !== lastModal) {
          // 新弹窗出现：记住归还目标，把焦点送进去
          if (!lastModal) modalReturnFocus = document.activeElement;
          lastModal = modal;
          modalLastInside = null;
          modalProgramming = true;
          const first = firstFocusableIn(modal);
          if (first) {
            first.focus({ preventScroll: true });
          } else {
            if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
            modal.focus({ preventScroll: true });
          }
          modalProgramming = false;
        } else if (!modal && lastModal) {
          // 弹窗关闭：焦点还给打开前的元素（S3：不在悬空状态才还）
          modalProgramming = true;
          if (modalReturnFocus && modalReturnFocus.isConnected) {
            try {
              modalReturnFocus.focus({ preventScroll: true });
            } catch {}
          }
          modalProgramming = false;
          lastModal = null;
          modalReturnFocus = null;
          // 弹窗关闭后的 interactive 补扫（2026-10-03 owner 动线实测抓出的真缺陷）：
          // 弹窗开着时发生的重扫（测试 3 的关→开、SPA 路由）会让 interactive 规则
          // 跳过弹窗外的全部元素，而弹窗一关没有任何人补扫 → 弹窗外的伪按钮语义
          // 永久缺失（v2-test 测试 3→5 连做，B 键到不了「组件内伪按钮」即此因）。
          // 弹窗已关，保护焦点陷阱的理由不复存在，补扫是安全的；幂等、零 AI。
          // 补扫含 shadowRoot（shadow 内伪按钮同样被门控跳过，见 shadow-scan.js）。
          (async () => {
            try {
              await window.WS_SHADOW?.rescanInteractiveAfterModal?.();
            } catch (e) {
              // 绝不静默吞错：补扫失败只影响"这次没补上的语义"，留痕排查
              console.warn('[WennSicht] 弹窗关闭后的语义补扫失败：', e);
            }
          })();
        }
      } catch {
        /* 单轮检查失败不影响下一轮 */
      }
    };
    // 弹窗多为「display 切换」而非 DOM 增删（v2-test 即如此），必须轮询属性 + 监听 DOM
    modalCheck = check;
    modalWatcher = setInterval(check, 400);
    document.addEventListener('click', check, true);
    document.addEventListener('keydown', check, true);
    // 焦点陷阱（2026-10-02 owner 实测：只送入不拦截，Tab 到关闭按钮后还是跑回背景）。
    // 弹窗开着时，任何落到弹窗外的 DOM 焦点都拉回弹窗内——等同 aria-modal 的标准
    // 焦点循环，属于焦点导航（S6），不改页面语义。
    modalTrap = (e) => {
      try {
        if (!lastModal || modalProgramming) return;
        const t = e.target;
        if (t && t.nodeType === 1 && lastModal.contains(t)) {
          modalLastInside = t; // 记录弹窗内最后位置
          return;
        }
        const back = modalLastInside && modalLastInside.isConnected ? modalLastInside : firstFocusableIn(lastModal) || lastModal;
        modalProgramming = true;
        back.focus({ preventScroll: true });
        modalProgramming = false;
      } catch {
        /* 单轮失败不致命 */
      }
    };
    document.addEventListener('focusin', modalTrap, true);
    // Tab 边界环绕（2026-10-02 owner 实测：focusin 陷阱只能"事后拉回"，而焦点从弹窗
    // 最后一个可聚焦元素按 Tab 会**先离开文档**（跳到浏览器地址栏/系统按钮），下一次
    // Tab 回到页面时已落在背景内容上——用户实感就是"先跳浏览器按钮、再跳背景内容"）。
    // 必须在 Tab 于边界按下时就 preventDefault 并手动环绕，焦点才永不离开弹窗
    //（标准 ARIA 对话框焦点陷阱；S6：仅焦点导航，不改页面语义、不点击）。
    modalTrapKey = (e) => {
      try {
        if (e.key !== 'Tab' || !lastModal || modalProgramming) return;
        const list = focusablesIn(lastModal);
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const idx = list.indexOf(document.activeElement);
        if (idx === -1) {
          // 焦点在弹窗外（或落在 body）→ 拉回弹窗首/尾
          e.preventDefault();
          (e.shiftKey ? list[list.length - 1] : list[0]).focus({ preventScroll: true });
          return;
        }
        if (!e.shiftKey && idx === list.length - 1) {
          e.preventDefault();
          list[0].focus({ preventScroll: true });
        } else if (e.shiftKey && idx === 0) {
          e.preventDefault();
          list[list.length - 1].focus({ preventScroll: true });
        }
      } catch {
        /* 单次按键失败不致命 */
      }
    };
    document.addEventListener('keydown', modalTrapKey, true);
    // 伪按钮键盘激活（2026-11-03 会话 45）：interactive 规则补的 div[role=button] 没有
    // 原生按键行为，焦点模式 Tab 过去按 Enter/Space 是死的（读屏念"按钮"却按不动）。
    // 把**用户的按键**转发为 click() —— 手势的直接映射，不是插件自动点击
    //（S6：用户不按键绝不碰）；标记 data-ws-btn 被一键还原后本监听自然失配，无副作用。
    if (!wsBtnActivate) {
      wsBtnActivate = (e) => {
        try {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          const t = e.target;
          if (!t || t.nodeType !== 1 || !t.closest) return;
          const tag = t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
          const btn = t.closest('[data-ws-btn]');
          if (!btn || !btn.isConnected) return;
          btn.click();
        } catch {
          /* 单次按键失败不致命 */
        }
      };
      document.addEventListener('keydown', wsBtnActivate, true);
    }
  }
  function stopModalWatcher() {
    if (modalWatcher) {
      clearInterval(modalWatcher);
      modalWatcher = null;
    }
    if (modalCheck) {
      document.removeEventListener('click', modalCheck, true);
      document.removeEventListener('keydown', modalCheck, true);
      modalCheck = null;
    }
    if (modalTrap) {
      document.removeEventListener('focusin', modalTrap, true);
      modalTrap = null;
    }
    if (modalTrapKey) {
      document.removeEventListener('keydown', modalTrapKey, true);
      modalTrapKey = null;
    }
    if (wsBtnActivate) {
      document.removeEventListener('keydown', wsBtnActivate, true);
      wsBtnActivate = null;
    }
    lastModal = null;
    modalReturnFocus = null;
  }

  // 焦点停放点（扩展对话框关闭路径的公共兜底，2026-10-11 取证）：
  // 对话框关闭前要把焦点送出，但「归还目标」有时接不住焦点——最常见的是**打开对话框时
  // 页面 DOM 焦点就是 body**（页面刚加载 / 读屏浏览态），而 `body.focus()` 在 Chrome 里
  // 不是一次真实焦点移动。此时若直接 remove()，被聚焦控件随节点销毁 → Chrome 把焦点退回
  // 文档对象并为此派发 a11y 焦点事件 → 读屏重读文档标题 + 当前行（owner 实测的「对话
  // 框一关就多念一段页面」）。停放点 = 扩展自有的 1px 隐藏落点（失焦即销毁，不留页面
  // 残渣），保证任何关闭路径都不留下「聚焦节点随节点销毁」。
  // 与长描述选图对话框的 `#ws-ldpick-echo` 同一模式（那个落点另外承载一句提示）。
  //
  // 2026-10-11 会话 29 补强：**落点必须有可访问名字**。此前停放点是**无名**的 1px 空 div，
  // 读屏聚焦到「无名 generic」后会**重定位并念页面内容**（会话 29 实测：反馈 / 问答两对话框
  // 关窗后 4/4 复现「关窗后念页面内容」，而带文案的选图落点从不产生噪声——对照实验
  // `dev/_probe-park.mjs` 证实：带文案落点 → 读屏恰好只念那一句、零多余）。故 `parkFocus`
  // 收一个文案参数，由落点承载该路径该说的一句提示（恰好一次）；调用方必须传文案。
  let parkEl = null;
  function parkFocus(text) {
    try {
      if (!document.body) return false;
      if (parkEl && parkEl.isConnected) {
        parkEl.textContent = text || '';
        parkEl.focus({ preventScroll: true });
        return true;
      }
      parkEl = document.createElement('div');
      parkEl.id = 'ws-focus-park';
      parkEl.setAttribute('data-ws-ignore-obs', '');
      parkEl.setAttribute('tabindex', '-1');
      parkEl.style.cssText =
        'position:absolute;width:1px;height:1px;margin:-1px;border:0;padding:0;' +
        'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
      parkEl.textContent = text || '';
      parkEl.addEventListener(
        'blur',
        () => {
          if (parkEl) {
            try {
              parkEl.remove();
            } catch {
              /* 已断开 */
            }
            parkEl = null;
          }
        },
        { once: true }
      );
      document.body.appendChild(parkEl);
      parkEl.focus({ preventScroll: true });
      return true;
    } catch {
      return false;
    }
  }
  // 作为**独立全局**暴露（不是只挂在 buildCtx 上）：反馈对话框在「未开启增强」时也
  // 必须可用，那时 ctx 为 null（见 WS_FEEDBACK_OPEN 分支）；页面问答同理不受 ctx 影响。
  window.WS_FOCUS_PARK = { park: parkFocus };

  function buildCtx() {
    return {
      setAttr,
      hide,
      forEachBatched,
      announce,
      isHidden: (el) => el.hasAttribute(HIDDEN_ATTR),
      modalRoot: () => findModalRoot(),
      ai: aiClient,
      describeImage: aiClient.describeImage,
    };
  }

  function stopImagePipeline() {
    window.WS_IMAGE_PIPELINE?.stop();
  }

  // P1 链接意图：只拆监听与队列，注入的 aria-description 由 journal 统一还原
  function stopLinkIntent() {
    window.WS_LINK_INTENT?.stop();
  }

  // P1 图表描述：同样只停队列，注入属性由 journal 还原
  function stopChartTable() {
    window.WS_CHART_TABLE?.stop();
  }

  // P2 表格解析：同上
  function stopTableParser() {
    window.WS_TABLE_PARSER?.stop();
  }

  // P2 表单辅助：只读模块，停掉监听即可（没有注入属性需要还原）
  function stopFormHelper() {
    window.WS_FORM_HELPER?.stop();
  }

  // 阶段 3.1/3.2：SPA 适配 —— 增强开启期间挂路由侦测与增量扫描，关闭时全部拆除
  function startSpaWatcher() {
    window.WS_SPA_WATCHER?.start(buildCtx());
  }

  function stopSpaWatcher() {
    window.WS_SPA_WATCHER?.stop();
  }

  // 记录本站点的开关状态（刷新后据此自动恢复）；「仅本页」模式不记忆
  async function rememberState(value = on) {
    if (ephemeral) return;
    if (!IS_TOP_FRAME) return; // 子框架不写存储（值相同，避免 N 份写入与徽标抖动）
    const { ws_active_sites = {} } = await chrome.storage.local.get('ws_active_sites');
    ws_active_sites[ORIGIN] = value;
    await chrome.storage.local.set({ ws_active_sites });
  }

  // 开关的执行体：`target` = 这次要落到页面上的目标态（true 开 / false 关）。
  // 与 `on`（用户想要的态）分开传，是为了能做「串行对账」——见 syncSwitch。
  async function runSwitch(target, { focus = false, forcedOpen = false, explicitNote = '' } = {}) {
    try {
      if (target) {
        await applyAll();
        startSpaWatcher();
        startInjectionVerify(); // 注入自愈抽查（会话 45：框架重渲染抹属性的兜底）
        // v0.2 第 7 项：开始记录滚动位置（手动开启不触发恢复——只有回到页面才有意义）
        await window.WS_POSITION_MEMORY?.start?.();
        // 决策模型场景解析（异步，不阻塞规则修复；失败静默）
        if (IS_TOP_FRAME) window.WS_SCENE?.run(buildCtx())?.catch?.(() => {});
      } else {
        // 停机步骤**逐个独立兜底**（2026-10-02 实测真缺陷）：
        // 原先这些调用串在一个 try 里，任何一步抛错都会直接跳过 restoreAll() →
        // 用户按下 Ctrl+Shift+Z 听到「已关闭」而页面**根本没还原**，且只有 console
        // 里一行 warn（盲用户永远看不到）。「一键还原页面」是 manifest 描述里对用户
        // 的承诺，而 restoreAll() 是唯一的还原入口，绝不能被任何一个 stop 拖死。
        const stopSteps = [
          ['SPA 观察', stopSpaWatcher],
          ['注入抽查', stopInjectionVerify],
          ['位置记忆', () => window.WS_POSITION_MEMORY?.stop?.()],
          ['组件扫描', () => window.WS_SHADOW?.stop()],
          ['反馈框', () => window.WS_FEEDBACK_UI?.close()],
          ['问答框', () => window.WS_PAGE_QA?.close()],
          ['图片管线', stopImagePipeline],
          ['链接意图', stopLinkIntent],
          ['图表描述', stopChartTable],
          ['表格结构', stopTableParser],
          ['表单提示', stopFormHelper],
          ['长描述', () => window.WS_IMAGE_LONGDESC?.detach()],
          ['布局地图', () => window.WS_LAYOUT_MAP?.detach()],
          ['动态播报', () => window.WS_LIVE_UPDATES?.stop()],
          ['弹窗看护', stopModalWatcher],
        ];
        for (const [name, fn] of stopSteps) {
          try {
            fn();
          } catch (err) {
            console.warn(`[WennSicht] 停机步骤「${name}」出错（已跳过，继续还原）:`, err);
          }
        }
        await restoreAll(); // 无论上面哪一步出错，都必须还原页面（超长 journal 分批）
      }
      await rememberState(target);
      if (target) {
        // 2026-10-25 SOLE_TRUTH：用户点名过的站点按「正常站点」播报——**不再提敏感类别**
        // （情形 ③⑤「正常运行，不播报敏感」）。只回一句「已按你的操作强制开启」作确认。
        const extra = forcedOpen ? ['已按你的操作强制开启。'] : [explicitNote, privacyNotice()];
        announce(joinSentences(openedMessage(), extra));
      } else {
        announce('无障碍增强已关闭，页面已恢复原状');
      }
      if (target && focus) focusDocTopIfLoose();
      if (!target) disposeLiveRegionSoon();
    } catch (err) {
      // 单条规则失败不影响开关状态反馈
      console.warn('[WennSicht] 切换过程中出错:', err);
      if (!target) {
        // 还原失败必须让用户知道（否则他以为页面已干净，实际还留着我们的注入）
        try {
          announce('页面还原时出现问题，部分内容可能仍保留增强标注，请刷新页面重试。');
        } catch { /* live region 都建不起来时放弃播报 */ }
      }
    }
  }

  // ---------- 串行对账（2026-10-24 · owner：「开了关关了开，鲁棒性够不够」）----------
  // 问题：`on = !on` 是同步翻转，而 applyAll / 一串 stop 是**异步**的。用户连按三下时，
  //   三次切换会**重叠执行**：先启动的 applyAll 还在往页面里写属性，后启动的 restoreAll
  //   已经把 journal 逆序还原并清空 ⇒ 页面留下**未登记的注入**（关掉后还带着改动），
  //   或者「听到已关闭、页面其实还开着」。盲用户完全无法自查。
  // 做法：on（想要的态）与 applied（页面真实态）分开，用 syncSwitch 单飞 + 循环对账：
  //   无论在切换过程中被按了多少下，最终一定收敛到最新一次 `on`，且两态之间只有一条
  //   串行链路（不会出现 apply 与 restore 互相踩）。
  let applied = false; // 页面当前是否已处于增强态（真实状态，不是用户意图）
  let switching = false; // 是否有一次性切换正在进行
  let pendingFocus = false;

  async function syncSwitch({ focus = false, forcedOpen = false, explicitNote = '' } = {}) {
    if (focus) pendingFocus = true;
    if (switching) return; // 正在切换：交给对账循环收尾，不叠加第二条链路
    switching = true;
    try {
      while (applied !== on) {
        const target = on;
        await runSwitch(target, { forcedOpen, explicitNote });
        applied = target;
        window.__WS_ON__ = applied; // 诊断探针：页面**真实**开关态（不是用户意图）
        // 强制/说明句只对「用户那次操作」说一次，循环里不重复
        forcedOpen = false;
        explicitNote = '';
      }
    } finally {
      switching = false;
      const f = pendingFocus;
      pendingFocus = false;
      if (applied && f) {
        try { focusDocTopIfLoose(); } catch { /* 忽略 */ }
      }
    }
  }

  // 页面级命令：只有顶层文档才有资格处理（见下方 onMessage 顶部的注释）
  const PAGE_LEVEL = new Set([
    'WS_TOGGLE',
    'WS_SUMMARY',
    'WS_QA_OPEN',
    'WS_LONGDESC_REQUEST',
    'WS_LAYOUT_REQUEST',
    'WS_FEEDBACK_OPEN',
    'WS_LIVE_REFRESH',
  ]);

  // ---------- 消息 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 会话 69 · 健康探针：SW 自愈重注入前用它判断本标签的内容脚本是否还活着。
    // 必须同步响应（SW 用 Promise.race 限时）；返回当前上下文状态便于诊断。
    // 孤立上下文里 chrome.runtime.id 会变 undefined，但 onMessage 端口通常已断，
    // 收不到这条 ⇒ SW 判定失效并补注入。
    if (msg?.type === 'WS_PING') {
      try {
        sendResponse({
          ok: true,
          alive: !!wsRuntimeId(),
          loaded: window.__WS_LOADED__ === true,
          on: window.__WS_ON__ === true,
          ctxId: WS_CTX_ID || null,
        });
      } catch { /* 通道已关 */ }
      return;
    }
    // 子框架不得处理页面级命令（2026-10-02 实测真缺陷，本项目最隐蔽的一个）：
    // 注册是 allFrames:true，而 SW 的 chrome.tabs.sendMessage 不带 frameId → 广播到
    // **所有**框架，而 sendResponse 只有一个赢家。实测 v2-test（本页带同源 iframe）上
    // Ctrl+Shift+Z 被**子框架**接走：顶层文档的 `on` 纹丝不动，连「已关闭」播报都没有，
    // 用户看到的就是「按了没反应」；而 verify 套件用 frameId:0 发消息，**测不到**。
    // 页面级开关/播报/UI 属顶层文档的事务 —— 子框架一律不接、**且不响应**（响应会让
    // 子框架抢走 sendResponse 的唯一胜者，那才是本缺陷的直接成因）。
    if (!IS_TOP_FRAME) {
      // 顶层切换后广播下来，让子框架跟着开/关（否则关掉增强后 iframe 仍在被改）
      if (msg?.type === 'WS_SYNC_STATE') {
        on = !!msg.on;
        syncSwitch({ focus: false });
        return;
      }
      // 页面级命令一律不接、**且不响应**（响应会让子框架抢走 sendResponse 的唯一胜者）
      if (PAGE_LEVEL.has(msg?.type)) return;
      // 其余消息（例：WS_PAUSE_IMAGES —— 子框架的图片管线也得能暂停）继续走原处理，
      // 它们的响应值在各框架一致，抢到响应通道也无副作用。
    }

    // 「暂停 AI 描述」快捷键（BP 4.3）：只停 AI 调用，词典与规则修复继续工作
    if (msg?.type === 'WS_PAUSE_IMAGES') {
      // 受闸门的页面什么都没跑 —— 按 SOLE_TRUTH「任何绑定快捷键都要指路」，回一句怎么开
      if (IS_TOP_FRAME && !on) {
        (async () => {
          const gate = await readGate();
          if (gate.blocked) {
            announce(gateOtherHint(gate.label));
            sendResponse({ paused: null, gated: true });
            return;
          }
          sendResponse({ paused: window.WS_IMAGE_PIPELINE?.togglePause() ?? null });
        })();
        return true;
      }
      const paused = window.WS_IMAGE_PIPELINE?.togglePause() ?? null;
      sendResponse({ paused });
      return;
    }

    // 「一键反馈」快捷键（阶段 3.5）：弹出无障碍反馈对话框
    if (msg?.type === 'WS_FEEDBACK_OPEN') {
      // 2026-10-25 SOLE_TRUTH：受闸门的页面上，**任何绑定好的快捷键**都只回一句「先连按两次
      // Ctrl+Shift+Z 强制开启」。反馈键也照此办理（owner 原话「任何绑定好的快捷键」）；
      // 若哪天想给反馈开个例外，只需删掉下面这个 if。
      (async () => {
        if (!on) {
          const gate = await readGate();
          if (gate.blocked) {
            announce(gateOtherHint(gate.label));
            sendResponse({ opened: false, gated: true });
            return;
          }
        }
        // 反馈在未开启增强时也可用 —— 只要内容脚本在页面上（B/P 3.5）
        const ctx = on ? buildCtx() : null;
        window.WS_FEEDBACK_UI?.open(ctx);
        sendResponse({ opened: !!window.WS_FEEDBACK_UI });
      })();
      return true;
    }

    // 「页面问答」快捷键（v0.2 第 9 项）：弹出只读问答对话框
    if (msg?.type === 'WS_QA_OPEN') {
      // 问答依赖区块/表格上下文与 live region，未开启增强时先提示开启（不弹空对话框）
      (async () => {
        if (!on) {
          const gate = await readGate();
          announce(gate.blocked
            ? gateOtherHint(gate.label)
            : notEnabledHint('页面问答'));
          sendResponse({ opened: false, gated: !!gate.blocked });
          return;
        }
        window.WS_PAGE_QA?.open(buildCtx());
        sendResponse({ opened: !!window.WS_PAGE_QA });
      })();
      return true;
    }

    // 框架级块 gather v2（2026-11-03 会话 45 · 缺口 #4）：tabs.sendMessage 多框架
    // **只有一个响应赢家**（WS_TOGGLE 处的实测教训），无法用响应做数组聚合。改为
    // storage.session 交接：子框架收到刷新广播后，把本框架的块节选写进 session
    // storage（键 ws_qa_frame:<帧令牌>，同一帧令牌稳定 → 重刷新覆盖自己），顶层延迟读取。
    if (msg?.type === 'WS_QA_GATHER_REFRESH') {
      if (window.top !== window) {
        (async () => {
          try {
            const blocks = window.WS_PAGE_QA?.gather?.() || [];
            await chrome.storage.session.set({
              [`ws_qa_frame:${WS_FRAME_TOKEN}`]: {
                url: location.href.slice(0, 120),
                blocks,
                ts: Date.now(),
              },
            });
          } catch {
            /* 本框架写失败：顶层就少一份，不阻塞问答 */
          }
        })();
      }
      return false; // 无需响应（SW 只广播，不收）
    }

    // 「图片长描述」快捷键（v0.2 第 10 项）：对用户当前所在的图发起一次长描述
    if (msg?.type === 'WS_LONGDESC_REQUEST') {
      // 同一次按键被重复投递（多个内容脚本实例 / 长按重复）时只处理一次：
      // 否则第一次打开选图列表、第二次立刻把它关掉，用户只会听到「选图列表已关闭」。
      const nowTs = Date.now();
      if (nowTs - (window.__WS_LAST_LONGDESC_AT__ || 0) < 150) {
        sendResponse({ accepted: true, deduped: true });
        return true;
      }
      window.__WS_LAST_LONGDESC_AT__ = nowTs;
      (async () => {
        if (!on) {
          const gate = await readGate();
          announce(gate.blocked
            ? gateOtherHint(gate.label)
            : notEnabledHint('图片长描述'));
          sendResponse({ accepted: false, gated: !!gate.blocked });
          return;
        }
        window.WS_IMAGE_LONGDESC?.requestFor();
        sendResponse({ accepted: true });
      })();
      return true;
    }

    // 「布局地图」快捷键（v0.2 第 10 项）：播报哪块该读、哪块可跳过（纯本地零 AI）
    if (msg?.type === 'WS_LAYOUT_REQUEST') {
      (async () => {
        if (!on) {
          const gate = await readGate();
          announce(gate.blocked
            ? gateOtherHint(gate.label)
            : notEnabledHint('布局地图'));
          sendResponse({ accepted: false, gated: !!gate.blocked });
          return;
        }
        window.WS_LAYOUT_MAP?.run();
        sendResponse({ accepted: true });
      })();
      return true;
    }

    // 设置页改动「动态变化播报」站点开关后通知已打开页面即时生效（v0.2 第 10 项）
    if (msg?.type === 'WS_LIVE_REFRESH') {
      window.WS_LIVE_UPDATES?.refresh();
      sendResponse({ accepted: true });
      return;
    }

    // 「页面结构摘要」快捷键（P1）：AI 总结当前页面
    if (msg?.type === 'WS_SUMMARY') {
      if (!on) {
        // 增强未开启：先激活（摘要依赖 ctx 的 live region 与 AI 门控）
        // 2026-10-24：摘要的隐式激活同样过敏感站点闸门 —— 否则「Ctrl+Shift+S」会绕过
        // 「敏感站点默认整页不处理」的约定（等于给了一条没人知道的暗门）。
        ephemeral = false;
        (async () => {
          try {
            const gate = await readGate();
            if (gate.blocked) {
              // 2026-10-25 SOLE_TRUTH：**别的快捷键不代劳、也不算进手势**——只指路。
              // （旧实现把这一下也记成手势第一下，于是「S 之后按一次组合键」就开了，
              //   违反「敏感站要用户明确连按两次」。）
              announce(gateOtherHint(gate.label));
              return;
            }
            // 走到这里说明没被闸门拦 ⇒ 用户「明确表示需要」：记进常用列表（情形 ⑥⑦）
            await persistExplicitEnable();
            on = true;
            await syncSwitch({ focus: true });
            await window.WS_SUMMARIZER?.run(buildCtx());
            // 摘要隐式开启了增强 → 同样要告诉子框架跟上
            chrome.runtime.sendMessage({ type: 'WS_BROADCAST_STATE', on: true }).catch(() => {});
          } catch (err) {
            // 保持开关状态反馈；但必须留痕——静默失败曾让整条管线失效一整天
            console.warn('[WennSicht] 启用失败:', err);
          }
        })();
      } else {
        window.WS_SUMMARIZER?.run(buildCtx());
      }
      sendResponse({ accepted: true });
      return;
    }

    if (msg?.type !== 'WS_TOGGLE') return;
    // SW 判断页面上没有内容脚本时会用 activeTab 注入，并带 ephemeral 标记
    ephemeral = !!msg.ephemeral;
    // 2026-10-24 敏感站点闸门：开启方向要先过闸门（关闭方向不受影响，任何页面都能一键还原）。
    // 判定要读存储 ⇒ 这里改成异步响应（return true 保持通道）；SW 会用 res.on 更新徽标。
    (async () => {
      try {
        // 手势尾巴（见 GESTURE_TAIL_MS 注释）：刚用「连按两次 Ctrl+Shift+Z」开启的 2.5 秒内，
        // 任何按键都算同一次手势——吞掉，并把尾巴顺延（一直按就一直不当作新指令）。
        const nowTs = Date.now();
        if (nowTs < absorbUntil) {
          absorbUntil = nowTs + GESTURE_TAIL_MS;
          sendResponse({ on, absorbed: true });
          return;
        }
        const explicitNote = '';
        if (!on) {
          const gate = await readGate();
          if (gate.blocked) {
            // 第 1 下只提示、第 2 下才开。计数**落盘**（刷新后仍算数，owner 2026-10-25）。
            if ((await noteGesturePress(gate.label)) >= 2) {
              await forceEnableEnhance();
              sendResponse({ on: true, forced: true });
              return;
            }
            announce(gateConfirmHint(gate.label));
            sendResponse({ on: false, gated: true });
            return;
          }
          // 没被闸门拦 ⇒ 这是用户「明确表示需要」：先把这个站点记进常用列表（情形 ⑥⑦）。
          await persistExplicitEnable();
        } else {
          // 关掉时清掉「第一次」的记录，免得下次单击被误当成手势第二下
          await clearArm();
          // 2026-10-31（owner）：「关掉」= 撤回点名 ⇒ 敏感站回到默认保护，
          // 设置页「敏感站点保护」里那条「已放行」随之消失（否则会出现"关了但列表里还开着"）。
          try {
            await window.WS_AI_PRIVACY?.releaseOptIn?.();
          } catch (err) {
            console.warn('[WennSicht] 撤回放行记录失败（不影响本次关闭）：', err);
          }
        }
        on = !on;
        syncSwitch({ focus: true, explicitNote });
        sendResponse({ on });
        // 把新状态播给子框架（经 SW 广播）。必须 sendResponse 之后再发：sendResponse
        // 是同步的，先发它才能保证顶层这一帧赢得响应通道，子框架的 WS_SYNC_STATE 无响应。
        chrome.runtime.sendMessage({ type: 'WS_BROADCAST_STATE', on }).catch(() => {});
      } catch (err) {
        // 判定/切换异常时保持可预期的反馈：不改变状态，也不静默
        console.warn('[WennSicht] 切换前判定失败：', err);
        sendResponse({ on });
      }
    })();
    return true;
  });

  // 焦点锚定（2026-09-29 刷新乱象修复）：刷新后 Chrome 常把焦点留在 body →
  // NVDA 宣布「文档」容器 = 从头读全页（用户听到全部 alttext 刷屏）。
  // 增强激活时若焦点悬空（body/html），移到第一个标题：NVDA 改报单条标题，
  // 且浏览光标落到页首，h/b 从头导航有序。焦点在具体控件上时绝不动（S3）。
  function focusDocTopIfLoose() {
    if (!IS_TOP_FRAME) return; // 子框架不得抢焦点（会把顶层文档的光标夺走）
    try {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) return;
      const h = document.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      if (!h) return;
      // 走 setAttr 登记，关增强时才能被 restoreAll 清掉（否则标题上会永久留下 tabindex="-1"）
      if (!h.hasAttribute('tabindex')) setAttr(h, 'tabindex', '-1'); // 仅程序化聚焦用，-1 不进 Tab 序（S1）
      h.focus({ preventScroll: true });
    } catch {
      // 忽略
    }
  }

  // ---------- 页面加载恢复 ----------
  // 此前开启过则自动恢复，否则保持休眠等待快捷键。两个方向都同步徽标状态。
  // 2026-10-01 owner 实测反馈（路标缺失/播报乱/打开即乱）：自动恢复链路一旦在某个
  // await 上卡住或抛错，用户面对的是「开了但什么都没发生」——完全不可观测。
  // 修复：①每步打点（ws_restore_debug 可关）；②**任何失败都要给用户一句播报**，
  // 绝不静默吞掉（静默失败曾让整条管线失效一整天，REFERENCE 坑清单第 1 条）。
  const RESTORE_DEBUG = '[WennSicht]';
  (async () => {
    const step = (name, t0) => console.log(`${RESTORE_DEBUG} 恢复·${name} ${Date.now() - t0}ms`);
    const t0 = Date.now();
    try {
      await announcePrefReady; // 先知道「要不要报细节」，再决定播什么（不然第一句可能漏判）
      // 会话 69：孤立上下文里 chrome.storage.local.get 会抛 "Extension context invalidated"。
      // 这是自动恢复链的第一个 await，旧实现一抛就整链中断（不设 __WS_ON__、不启动观察器、
      // 不播报），用户看到「功能全没了」。改用安全包装：拿不到存储时按「未启用」安静休眠，
      // 不抛未捕获异常；SW 自愈重注入后会重新跑一遍完整初始化。
      const { ws_active_sites = {}, ws_global = false, ws_sites = {} } = await safeStorageGet([
        'ws_active_sites',
        'ws_global',
        'ws_sites',
      ], { ws_active_sites: {}, ws_global: false, ws_sites: {} });
      const perSite = ws_active_sites[ORIGIN];
      // 启用判定（2026-11-05 owner 实测反馈定案，优先级从高到低）：
      // ① **全局开启 → 一律自动开启**。owner 2026-09-30 裁决原话「只要选了全局：
      //    不管其他配置，全部启用」，2026-11-05 再次确认（"就算全局启用，网站也不会
      //    自动开启"是缺陷）。此前「逐站显式 false 压过全局」的口径与裁决矛盾：
      //    历史开关残留（用户按过、回归套件的开关痕迹）会让全局模式下站点永远休眠。
      // ② 逐站记录：true 开 / false 关——用户在本站按 Ctrl+Shift+Z 的最后一次表态，
      //    仅在未开全局时生效。
      // ③ **允许列表（ws_sites）= 默认开启**（owner 2026-11-05："加入了 allowlist
      //    就要自动开启"）：无逐站记录时，站点在列表里即自动开启。与页面内「添加站点」
      //    流程（SW 的 WS_ADD_SITE 写 ws_active_sites=true）语义对齐；设置页「添加站点」
      //    现在也写 true（options.js addSite）。
      // ⚠️ 套件联动：回归套件的「清站点记忆」必须写**显式 false** 而非 delete，
      //    否则夹具页会被 ③ 自动开启、首个 WS_TOGGLE 变成「关」→ 套件假红
      //    （这正是 2026-10-24 那次撤回的根因；本次把语义定对、套件配合改）。
      // 仍**不回写** ws_active_sites[ORIGIN]：全局一旦关掉，站点自然回落到 ②/③/休眠。
      const saved =
        ws_global === true ? true
        : perSite === true ? true
        : perSite === false ? false
        : ws_sites[ORIGIN] ? true
        : undefined;
      if (saved === undefined) {
        // 2026-10-25 SOLE_TRUTH 情形⑦：逐站模式 + 这个站没开过 ⇒ 默认关闭。
        // 但**敏感站要播一句「默认关闭」**（owner 明确要求），所以这里仍要判一次类别；
        // 非敏感页保持安静（情形⑥「不播报敏感」）。判定是纯本地 + 一次存储读，代价可接受。
        const gate = await readGate();
        if (gate.blocked) announce(gateHint(gate.label), { boot: true });
        step('未启用·敏感站提示', t0);
        return;
      }
      step('读状态', t0);
      if (saved === true) {
        // 2026-10-24：敏感站点默认整页不处理（owner 口径，见 readGate 上方注释）。
        // 必须先判定再激活：applyAll 里的 AI 能力一旦先跑，就是「先发出一枪再上锁」。
        const gate = await readGate();
        if (gate.blocked) {
          // 刻意**不销毁** live region：① 用户很可能马上再按快捷键，留着它这句提示可以
          // 立刻复用（新建 region 要等 ~150ms 挂钩，读屏会吞掉）；② 本路径没有别的注入物
          // 需要清理（region 是 1px 裁剪的 role=status，不占版面、不参与焦点）。
          announce(gateHint(gate.label), { boot: true });
          // 徽标与子框架对齐「未开启」，否则图标显示已开启而页面什么都没变
          await chrome.runtime.sendMessage({ type: 'WS_STATE_SYNC', on: false }).catch(() => {});
          step('敏感站点默认关闭', t0);
          return;
        }
        on = true;
        await applyAll();
        applied = true; // 页面真实态：自动恢复也走同一条对账记账，否则第一次「关」会被认为无事可做
        window.__WS_ON__ = true;
        step('applyAll', t0);
        startSpaWatcher();
        // 会话 51 诊断钩子：记录「开场管线确实被调用过」，与 AI / 金库是否可用无关。
        // 回归用它证明「软刷新只静音播报，没有跳过修复或 AI 管线」；不能拿
        // WS_SCENE.get() 当证据——那要模型调用成功，锁金库时会变成假红。
        const sceneStarted = typeof window.WS_SCENE?.run === 'function';
        if (sceneStarted) window.WS_SCENE.run(buildCtx())?.catch?.(() => {});
        window.__WS_BOOT_RUN__ = { applyAll: true, sceneStarted };
        // v0.2 第 7 项：刷新 / 后退前进回来时，先恢复上次读到的地方（仅顶层框架）。
        const pm = window.WS_POSITION_MEMORY;
        await pm?.start?.();
        const pos = (await pm?.restore?.({
          // 「已自动恢复上次阅读位置」必须抢在 NVDA 读出恢复位置内容**之前**（2026-10-03
          // owner 要求：否则用户只听到突然跳到的内容，一头雾水）。polite 播报会被焦点
          // 事件的朗读整个清掉（测试 7 f1 同款教训），走打断式（唯一 region 临时
          // assertive，~700ms 后自动恢复 polite）；position-memory 会先回调这里、
          // 等短句说出口再聚焦——先听「为什么」，再听「在哪」，统计殿后。
          beforeFocus: () => announce('已自动恢复上次阅读位置', { urgent: true, boot: true }),
        })) || { restored: false };
        step('位置恢复', t0);
        // 「打开页面自动读一大段正文」的根因是 NVDA 默认开启的「页面加载完成后朗读
        // 所有内容」（autoSayAllOnPageLoad，configSpec default=true；2026-10-02 从
        // NVDA library.zip 字节码 + 更新日志 #1499 取证定案），并在 willSayAllResume
        // 机制下每次加载续播——扩展侧任何打断都可能喂这个循环，故修复走 NVDA 设置
        // （设置页引导 + nvda-optimize.ps1），扩展侧保持礼貌即时播报不参与竞争。
        // 开启统计句恢复播报（位置句已前移到 beforeFocus 打断式播出）。
        // 2026-10-25 SOLE_TRUTH：情形 ③⑤ 是「正常运行、不播报敏感」——这里只说增强做了什么。
        // （2026-10-24 曾补一句「增强是你此前强制开启的」，按新定案撤掉：那个站已经是普通站点了。）
        announce(joinSentences(openedMessage(), [privacyNotice()]), { boot: true });
        // 恢复成功后不再把焦点挪回页首（否则与恢复位置打架）
        if (!pos.restored) focusDocTopIfLoose();
      }
      await chrome.runtime.sendMessage({ type: 'WS_STATE_SYNC', on: saved }).catch(() => {});
      step('完成', t0);
    } catch (err) {
      // 状态恢复失败：**必须让用户知道**（保底播报），同时留痕。保持 on 状态一致。
      console.warn('[WennSicht] 页面加载恢复失败:', err);
      try {
        announce('无障碍增强自动恢复时出现问题，请按 ${toggleKey()} 关闭后重新开启。');
      } catch {
        /* live region 都建不起来时放弃播报 */
      }
    }
  })();
})();
