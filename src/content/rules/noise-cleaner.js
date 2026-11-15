// 阶段 1.3：DOM 噪音清理（纯规则，不用 AI —— BP 4.2）
// 1) 重复导航：仅隐藏与前面导航「内容完全相同」的冗余导航，以及空的无名导航地标
// 2) 广告容器：常见广告 class / id 启发式识别
// 3) 空容器：仅隐藏「向辅助技术暴露了容器语义但没有内容」的元素
// 4) 浮层广告（v0.2）：几何 + 白名单 + 决策模型三级从严（详见第 4 段注释）
//
// 「不做的事」（BP 4.2）：不删除任何元素、不移动元素位置、
// 不修改任何文本、不触碰表单元素、不改已有 role / aria-*。
// 全部通过隐藏属性隐藏，可由编排器一键还原。
//
// 实测教训（2026-09-27）：
//   - 原「重复导航」按顺序保留第一个、隐藏其余 → 会误删面包屑、分页等
//     互不相同的合法导航。改为「仅当内容与前面某个导航完全一致」才隐藏。
//   - 原「空元素」清理任意无文本无子元素的 div → 隐藏了 JS 动态内容的挂载点
//     （实测：<div id="toasts"> 在页面加载时为空，被隐藏后页面所有通知都不再显示），
//     真实网站上这类挂载点极常见（弹窗、下拉菜单、Portal 容器），且字体图标/
//     伪元素图标也会被误伤。改为仅处理「空且暴露容器语义」的元素。
//
// 增量口径（2026-11-03 会话 45，瀑布流性能）：
//   - roots 为空（开启增强 / SPA 路由切换）→ 四段全文档扫描，行为与旧版一致；
//   - roots 非空（spa-watcher 增量批次）→ 第 2/3/4 段只扫**新增子树**（局部启发式，
//     量小且与全文档无关）；第 1 段（重复导航）需要全文档视野，仅在「新增子树
//     确实含 nav」且距上次全量 ≥3s 时才重跑——高频变动页面不再每 3 秒全页扫一遍。
window.WS_RULES = window.WS_RULES || {};

// ---------- 推广浮层判定：模块级缓存与预算（2026-11-03 会话 45） ----------
// 旧实现把缓存 Map 放在 noise() 函数内，注释声称「跨重扫复用」但实际每次调用都新建：
// 同一个「非推广」浮层会被反复送判（增量链路下相当于每 3 秒最多 3 次模型调用，纯浪费）。
// 现提为模块级：key = 浮层文本前 120 字；另给元素打 data-ws-promo-judged 标记双保险。
//
// ⚠️ 会话 69：这些声明刻意用 **var + window 单例**，不用 const/let。原因：
//    扩展重载后 SW 会对长期开着的标签做「自愈重注入」，27 个脚本会再次在同一个
//    隔离世界执行；顶层 const/let 重复声明会抛 `SyntaxError: Identifier already
//    declared` ⇒ 重注入整批中断（实测抓到 PROMO_VERDICTS / lastLandmarkRun 两例）。
//    var 重复声明合法；状态对象挂 window 保证**重注入后预算/缓存不丢失**
//    （否则 promoJudgedTotal 归零会重复烧模型调用）。此改动不改变任何产品行为。
var PROMO_STATE = window.__WS_PROMO_STATE__ || (window.__WS_PROMO_STATE__ = {
  verdicts: new Map(),
  judgedTotal: 0,
  lastDupNavRun: 0,
});
var PROMO_VERDICTS = PROMO_STATE.verdicts;
var PROMO_VERDICTS_MAX = 200;   // FIFO 上限，防长会话泄漏
var PROMO_BUDGET_PER_SCAN = 3;  // 单次扫描最多送判 3 个（口径不变）
var PROMO_BUDGET_PER_PAGE = 12; // 每页送判总预算（新增：无限滚动不再持续烧模型）
var PROMO_RETRY_DELAYS = [1200, 3000]; // 瞬断重试退避（明确的低置信判定不重试）
// promoJudgedTotal / lastDupNavRun 改成读写 PROMO_STATE，见下方别名函数。
function wsPromoJudged() { return PROMO_STATE.judgedTotal; }
function wsPromoJudgedAdd(n) { PROMO_STATE.judgedTotal += n; }
function wsPromoJudgedReset() { PROMO_STATE.judgedTotal = 0; }
function wsDupNavLast() { return PROMO_STATE.lastDupNavRun; }
function wsDupNavSet(t) { PROMO_STATE.lastDupNavRun = t; }

function promoCacheGet(key) {
  return PROMO_VERDICTS.get(key);
}
function promoCacheSet(key, val) {
  if (PROMO_VERDICTS.size >= PROMO_VERDICTS_MAX) {
    const first = PROMO_VERDICTS.keys().next().value;
    if (first !== undefined) PROMO_VERDICTS.delete(first);
  }
  PROMO_VERDICTS.set(key, val);
}

// 测试钩子（verify-overlay ⑧ 故障注入用）：清空判定缓存与页内预算，把已跑过的页面
// 恢复成「全新页面」状态，让重试路径可被反复验证。产品逻辑不得调用。
window.WS_RULES.__resetPromoCache = () => {
  PROMO_VERDICTS.clear();
  wsPromoJudgedReset();
};

WS_RULES.noise = async (ctx, roots) => {
  const incremental = Array.isArray(roots) && roots.length > 0;
  const scanRoots = incremental ? roots : [document.body];
  // 统一的「根列表内收集」：根自身命中选择器也算（增量 roots 常是卡片/容器本身）
  const collect = (sel) => {
    const out = [];
    for (const r of scanRoots) {
      if (!r) continue;
      try {
        if (r.matches?.(sel)) out.push(r);
        out.push(...r.querySelectorAll(sel));
      } catch {
        // 断开的子树等异常：跳过
      }
    }
    return out;
  };

  // ---------- 1) 重复导航（需要全文档视野；增量时按条件限频） ----------
  const rootsHaveNav = incremental
    && scanRoots.some((r) => {
      try {
        return !!(r.matches?.('nav, [role="navigation"]')
          || r.querySelector?.('nav, [role="navigation"]'));
      } catch {
        return false;
      }
    });
  if (!incremental || rootsHaveNav) {
    const now = Date.now();
    if (!incremental || now - wsDupNavLast() > 3000) {
      wsDupNavSet(now);
      const navs = Array.from(document.querySelectorAll('nav, [role="navigation"]'));
      const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const seenText = new Set();
      const redundantNavs = [];
      for (const nav of navs) {
        if (ctx.isHidden(nav)) continue;
        const key = norm(nav);
        // 空的无名导航地标：屏幕阅读器会读出"导航，空"，属真实噪音，且无导航可丢
        const named = nav.hasAttribute('aria-label') || nav.hasAttribute('aria-labelledby');
        if (!key) {
          if (!named) redundantNavs.push(nav);
          continue;
        }
        // 内容与前面某个导航完全一致才算冗余
        if (seenText.has(key)) redundantNavs.push(nav);
        else seenText.add(key);
      }
      await ctx.forEachBatched(redundantNavs, (el) => {
        ctx.hide(el);
      });
    }
  }

  // ---------- 2) 广告容器 ----------
  // 仅整词匹配 class / id 中的广告标记，避免误伤 read / head / add 等词。
  const AD_TOKENS = new Set([
    'ad', 'ads', 'advert', 'advertise', 'advertisement', 'advertisements',
    'ad-container', 'ad-wrapper', 'adbox', 'adboxs', 'sponsor', 'sponsored',
    'sponsorship', 'promo', 'promotion',
  ]);
  const AD_IFRAME_SELECTORS = [
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="googleadservices"]',
    'iframe[src*="adserver"]',
  ];

  const isAdToken = (token) => AD_TOKENS.has(token.toLowerCase());

  const adCandidates = new Set();
  for (const r of scanRoots) {
    if (!r) continue;
    try {
      for (const sel of AD_IFRAME_SELECTORS) r.querySelectorAll?.(sel).forEach((el) => adCandidates.add(el));
    } catch {
      /* 忽略 */
    }
  }
  for (const el of collect('[class], [id]')) {
    if (el.closest('nav, [role="navigation"], main, article, [role="main"]')) continue;
    const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    const id = (el.getAttribute('id') || '').trim();
    const idTokens = id.split(/[-_\s]+/).filter(Boolean);
    if (classes.some(isAdToken) || idTokens.some(isAdToken)) adCandidates.add(el);
  }
  await ctx.forEachBatched(adCandidates, (el) => {
    ctx.hide(el);
  });

  // ---------- 3) 空容器 ----------
  // 只有「空 + 向辅助技术暴露容器语义」的元素才值得隐藏：
  // 屏幕阅读器会读出"导航/区域/列表，空"这类噪音，隐藏它不会丢任何内容。
  // 普通空 div/span 不处理 —— 它们既几乎不产生朗读噪音，又常常是动态内容的挂载点
  // 或图标载体，隐藏会破坏页面功能与视觉。
  const CONTAINER_ROLES = new Set([
    'region', 'group', 'list', 'listbox', 'menu', 'menubar', 'tablist', 'tabpanel',
    'navigation', 'banner', 'contentinfo', 'complementary', 'main', 'search', 'form',
    'table', 'grid', 'tree', 'treegrid', 'directory', 'feed', 'article', 'toolbar',
    'dialog', 'alertdialog', 'application', 'log', 'status', 'marquee', 'timer',
  ]);

  const empties = [];
  for (const el of collect('[role]')) {
    const role = (el.getAttribute('role') || '').trim().toLowerCase();
    if (!CONTAINER_ROLES.has(role)) continue;
    if (el.childElementCount > 0) continue;
    if ((el.textContent || '').trim()) continue;
    if (el.hasAttribute('hidden') || ctx.isHidden(el)) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (el.closest('button, a, input, select, textarea, label, form')) continue;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      continue;
    }
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    empties.push(el);
  }
  await ctx.forEachBatched(empties, (el) => {
    ctx.hide(el);
  });

  // ---------- 4) 浮层广告（v0.2；增量 = 只扫新增子树） ----------
  // 用户决策：**全自动隐藏，不要用户手势**（"视障用户导航够累了没必要"）。
  // 自动 = 更危险，所以三级从严，任一级不通过就保留：
  //   ① 几何：fixed/sticky + z-index ≥ 100 + 尺寸合理（排除全屏遮罩与微小浮标）
  //   ② 白名单硬排除：含表单控件 / 含主要操作词（购买·提交·登录·客服…）/
  //      是页面唯一导航 / 含 aria-modal、role=dialog → 一律不隐藏
  //   ③ 决策模型判「纯推广浮层」：概率 ≥ 0.6 才隐藏；低置信 / 调用失败 / 未配 AI
  //      → 一律保留（与 alt 判定同一口径：宁缺勿假）
  // 同意弹窗（cookie / 隐私政策）：**不隐藏**——藏了遮罩往往还在，用户会从
  // 「能听到弹窗」变成「读不到内容也找不到弹窗」，更惨。改为计数上报，
  // 由开启播报统一提示"需要你处理"。
  window.WS_STATS = window.WS_STATS || {};
  if (!incremental) window.WS_STATS.consentOverlays = 0;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw > 0 && vh > 0) {
    // 主要操作词：出现任一个 → 这个浮层可能是用户唯一的操作入口，绝不隐藏
    const KEEP_RE =
      /(加入购物车|立即购买|马上抢|去结算|立即结算|提交|登录|注册|联系客服|在线咨询|拨打|立即报名|投递|预约|马上咨询)/;
    // 同意类：不隐藏，只上报
    const CONSENT_RE = /(同意|接受|Cookie|cookie|隐私政策|用户协议|接受全部|同意并继续)/;
    let promoJudged = 0; // 本次扫描的送判计数（每批 3 个）

    const overlays = [];
    let consentCount = 0;
    for (const el of collect('div, section, aside, ul')) {
      if (ctx.isHidden(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      // 已判定过的不再送判（模块缓存 + 元素标记双保险，见文件头说明）
      if (el.hasAttribute('data-ws-promo-judged')) continue;
      if (el.closest('main, [role="main"]')) continue; // 正文里的吸顶元素不是浮层广告
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch {
        continue;
      }
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const z = Number.parseInt(cs.zIndex, 10);
      if (!Number.isFinite(z) || z < 100) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 40) continue;
      if (r.width * r.height > vw * vh * 0.6) continue; // 超过六成视口：全屏遮罩/主容器另案

      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      // ② 白名单硬排除
      if (el.querySelector('input, select, textarea, form')) continue;
      if (KEEP_RE.test(text)) continue;
      if (el.hasAttribute('aria-modal') || el.querySelector('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')) continue;
      // 是页面唯一导航 → 保留（浮动导航抽屉在窄屏很常见）
      const linkCount = el.querySelectorAll('a[href]').length;
      if (linkCount >= 3 && !document.querySelector('nav a[href], [role="navigation"] a[href]')) continue;
      if (linkCount >= 8) continue;

      // 同意弹窗：只计数，不隐藏
      if (CONSENT_RE.test(text)) {
        consentCount++;
        continue;
      }
      if (!text) continue;
      overlays.push({ el, text });
    }
    window.WS_STATS.consentOverlays =
      (Number(window.WS_STATS.consentOverlays) || 0) + consentCount;

    // ③ 决策模型判纯推广 —— **刻意不 await**：决策模型是网络调用，而 BP 4.3 要求
    // "页面加载后 0–1 秒只做规则修复"、绝不阻塞屏幕阅读器。几何与白名单是同步的
    // （已经筛过一轮），决策模型判定与隐藏整体放到后台异步进行，完成后补一句短播报。
    if (overlays.length) {
      (async () => {
        try {
          const hideList = [];
          for (const { el, text } of overlays) {
            const key = text.slice(0, 120);
            let promo = promoCacheGet(key);
            if (promo === undefined) {
              if (promoJudged >= PROMO_BUDGET_PER_SCAN) break; // 本批预算用尽：其余保留（宁缺勿假）
              if (wsPromoJudged() >= PROMO_BUDGET_PER_PAGE) break; // 本页总预算用尽
              promoJudged++;
              wsPromoJudgedAdd(1);
              // 瞬断重试（2026-10-10 owner 实测「测试 4 广告未隐藏」修复）：判定调用可能
              // 因网络抖动 / 中转冷启动 / SW 重启单次失败；旧实现一次失败就当成「保留」，
              // 而本页**此后不再重扫**——用户看到的就是「广告没被隐藏」，且没有任何提示。
              // 只重试「调用失败」；挂死/失败之外的明确判定一律采信（宁缺勿假不回退）。
              let verdictPro = null;
              let lastErr = null;
              for (let attempt = 0; attempt <= PROMO_RETRY_DELAYS.length; attempt++) {
                try {
                  const resp = await chrome.runtime.sendMessage({
                    type: 'WS_AI_DECIDE',
                    state: {
                      overlay_text: window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(text, 200) : text.slice(0, 200),
                      overlay_links: String(el.querySelectorAll('a[href]').length),
                    },
                    questions: {
                      pure_promo: {
                        type: 'noul',
                        instructions: '这个网页浮层是纯粹的推广/广告吗（促销导流、下载 App、抽奖、优惠券、无关推荐）？',
                        criteria: {
                          true: '是纯推广/广告浮层——隐藏它不会让用户丢失任何功能、导航、通知或内容',
                          false: '不是——它包含用户在意的功能、导航、通知或内容，应当保留',
                        },
                      },
                    },
                  });
                  if (!resp?.ok) throw new Error(resp?.error || '决策调用失败');
                  const verdict = resp.answers?.pure_promo || {};
                  // noul 返回形状兼容：数值概率（0-1）或布尔（见 image-pipeline 的实测结论）。
                  // 形状异常（undefined/字符串）视为调用失败走重试，而不是当 0（保留）吞掉。
                  if (typeof verdict.noul === 'number') verdictPro = verdict.noul >= 0.6;
                  else if (verdict.noul === true) verdictPro = true;
                  else if (verdict.noul === false) verdictPro = false;
                  else throw new Error('判定返回缺少 noul 字段');
                  lastErr = null;
                  break;
                } catch (err) {
                  lastErr = err;
                  if (attempt < PROMO_RETRY_DELAYS.length) {
                    await new Promise((r) => setTimeout(r, PROMO_RETRY_DELAYS[attempt]));
                  }
                }
              }
              if (lastErr) console.warn('[WennSicht] 推广浮层判定失败（已重试）：', lastErr?.message || lastErr);
              promo = verdictPro === null ? false : verdictPro; // 全部尝试失败 = 保留
              promoCacheSet(key, promo);
              // 判定完成即打标记：下一批增量扫描不再送判（无论结论真假）
              try {
                ctx.setAttr(el, 'data-ws-promo-judged', '');
              } catch {
                /* 元素已断开：跳过标记 */
              }
            }
            if (promo) hideList.push(el);
          }
          if (!hideList.length) return;
          await ctx.forEachBatched(hideList, (el) => ctx.hide(el));
          window.WS_STATS.hiddenPromoOverlays =
            (Number(window.WS_STATS.hiddenPromoOverlays) || 0) + hideList.length;
          ctx.announce(`已隐藏 ${hideList.length} 个推广浮层。`, { boot: true });
        } catch {
          // 后台任务失败不影响规则阶段（宁缺勿假：没隐藏就是保留）
        }
      })();
    }
  }
};
