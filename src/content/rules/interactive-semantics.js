// 阶段 1.5：交互元素语义补充（BP 安全护栏 S1 / S2 严格执行）
//
// S2 补 tabindex="0" 必须同时满足：
//   1) 元素是 div 或 span
//   2) 有点击行为（内联 onclick 属性，或 cursor:pointer —— 隔离世界看不到
//      页面 addEventListener，用计算样式启发式判断）
//   3) 无原生 role
//   4) 不在 aria-hidden="true" 容器内
//
// 附加保守条件（防误伤）：
//   - 不在 button / a / input 等原生交互元素内部（避免嵌套语义）
//   - 不在已有交互 role 容器内部
//   - 已有 tabindex / aria-* 的元素一律不动（S3 不覆盖已有语义）
//
// S1：只用 tabindex="0"，永远不用正数。
// 说明：只补 role 与 tabindex，不添加键盘事件处理（S6 只读不写；BP「保守注入」）。
window.WS_RULES = window.WS_RULES || {};

WS_RULES.interactive = async (ctx, roots) => {
  // roots 为空 → 全文档；否则仅扫描新增子树（增量模式，roots 含子树自身）
  const SEL = 'div, span';
  const rootList = Array.isArray(roots) && roots.length ? roots : [document.body];
  const candidates = [];
  for (const r of rootList) {
    if (!r) continue;
    try {
      if (r.matches?.(SEL)) candidates.push(r);
      candidates.push(...r.querySelectorAll(SEL));
    } catch {
      // 断开的子树等异常：跳过
    }
  }

  // 模态根：弹窗打开时把注入限制在弹窗内部（v0.2 模态框保护）
  const modal = typeof ctx.modalRoot === 'function' ? ctx.modalRoot() : null;
  const BUDGET_MS = 400;
  const tStart = performance.now();
  let budgetWarned = false;

  await ctx.forEachBatched(candidates, (el) => {
    // 会话 70（owner：「不能因为网站体量而延迟播报」）：维基百科这类 15.9k 节点页面上，
    // 候选（全部 div/span）逐个 closest ×3 + getComputedStyle 要 ~1.9s。按**时间预算**
    // 封顶 ~400ms（到点后剩余候选直接断过），既保住「不阻塞读屏」也不让播报等它。
    // 普通页面远达不到预算，行为不变；新内容由 SPA 观察器增量再扫。
    if (performance.now() - tStart > BUDGET_MS) {
      if (!budgetWarned) {
        budgetWarned = true;
        console.warn(
          `[WennSicht] 交互语义候选扫描达时间预算（${BUDGET_MS}ms），剩余候选跳过（内容更新时会增量再扫）。`
        );
      }
      return;
    }
    // 条件 4：aria-hidden 容器内不处理（S2）
    if (el.closest('[aria-hidden="true"]')) return;

    // v0.2 模态框保护：网站弹窗打开时只处理弹窗内部 —— 给背景元素补 tabindex
    // 会让用户按 Tab 从弹窗里跑出去、迷失在背景（技术背调 2.2.2）。
    // 保护是即时的：弹窗关闭后重新扫描（增量/路由/重开增强）即恢复正常注入。
    if (modal && !modal.contains(el)) return;

    // 不在原生交互元素内部（防嵌套语义）
    if (el.closest('button, a, input, select, textarea, label')) return;
    // 不在已有交互语义的容器内部
    if (
      el.closest(
        '[role="button"], [role="link"], [role="tab"], [role="menuitem"], ' +
        '[role="option"], [role="checkbox"], [role="radio"], [role="switch"]'
      )
    )
      return;

    // 条件 3：无 role（S3 不覆盖已有语义）
    if (el.hasAttribute('role')) return;
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return;
    // 已有 tabindex 的不动
    if (el.hasAttribute('tabindex')) return;

    // 未渲染的元素不标注（2026-09-29 压力夹具暴露）：display:none 的伪按钮
    // （真实站隐藏轮播/模板常态）补 role=button 属纯属性垃圾；与 heading-fixer
    // 的可见性检查对齐。
    let cs0 = null;
    try { cs0 = getComputedStyle(el); } catch { /* 断开子树按可见处理 */ }
    if (cs0 && (cs0.display === 'none' || cs0.visibility === 'hidden')) return;

    // 条件 2：点击行为（内联 onclick 或 cursor:pointer）
    // ⚠️ cursor 是**继承属性**：容器一旦设了 cursor:pointer，它里面每一段文字都会
    // 「计算为 pointer」。只认这个值会把播放器/栏目容器里的所有文本都标成按钮
    //（2026-11-15 bilibili 视频页实测：239 个 role=button，其中弹幕/动画浮层
    // `bili-danmaku-x-*` 全是继承来的）。所以要求「指针样式由元素自己引入」——
    // 它的值与父元素不同；显式内联 onclick 不受此限。
    let pointer = false;
    if (el.hasAttribute('onclick')) {
      pointer = true;
    } else {
      try {
        const own = cs0 || getComputedStyle(el);
        if (own.cursor === 'pointer') {
          const parentCursor = el.parentElement ? getComputedStyle(el.parentElement).cursor : '';
          pointer = parentCursor !== 'pointer';
        }
      } catch {
        pointer = false;
      }
    }
    if (!pointer) return;

    // 名字来源检查：元素自身没有文本、也没有能提供名称的子元素（带 alt 的图 /
    // aria-label 的 svg）时，补 role=button 只会产出无名按钮 —— 屏幕阅读器念
    // "按钮"却不知道是什么，比不可达更糟（axe aria-command-name 实测暴露）。
    // 这种元素几乎都是纯图形图标，命名是图片管线的事，不是规则的事。
    //
    // 2026-11-15（bilibili 实测「按 B 一路只听到『按钮按钮』」）：旧实现用 textContent，
    // 它把**不可见的文本**（display:none 的悬浮层、<script>/<style> 里的 JS 字符串）
    // 也算成名字 ⇒ 规则注入成功，无障碍名却是空的。改用 innerText（只算渲染出来的
    // 文本，天然排除隐藏子树与脚本），并剔除零宽字符；子元素命名也要求属性非空
    //（旧选择器 [aria-label]/[title] 会匹配空值）。
    let visibleText = '';
    try { visibleText = el.innerText || ''; } catch { visibleText = el.textContent || ''; }
    visibleText = visibleText.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
    const namedChild = el.querySelector(
      'img[alt]:not([alt=""]), svg[aria-label]:not([aria-label=""]), ' +
      '[aria-label]:not([aria-label=""]), [title]:not([title=""])'
    );
    const ownTitle = (el.getAttribute('title') || '').trim();
    if (!visibleText && !namedChild && !ownTitle) return;

    // 内部已含可聚焦元素（链接/表单/按钮）的容器不能补 button —— 会造成
    // "按钮里套链接"的嵌套交互语义，屏幕阅读器用户够不到里面的链接
    //（真实站"我已阅读并同意《协议》"勾选块实测暴露）。
    // 注意排除 [tabindex="-1"]：那是 heading-fixer 给伪标题补的可编程聚焦标记，
    // 用户根本无法 Tab 到它，不构成嵌套交互（2026-10-03 随伪标题补 -1 同步调整）。
    if (
      el.querySelector(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), ' +
        '[role="button"], [role="link"], [role="checkbox"], [role="switch"]'
      )
    )
      return;

    // 通过全部条件：补充 role + tabindex="0"（S1：只用 0，永不用正数）
    ctx.setAttr(el, 'role', 'button');
    ctx.setAttr(el, 'tabindex', '0');
    // 2026-11-03 会话 45：键盘激活标记。div role=button 没有 Enter/Space 的默认行为，
    // 焦点模式 Tab 过去按 Enter 是死的；content.js 的 keydown 看到本标记会把用户的
    // 按键转发为 click()——这是**用户手势的直接映射**，不是插件自动点击（S6 不越界：
    // 不按的时候绝不碰）。标记走 journal，关闭增强随一键还原消失，转发自动停止。
    ctx.setAttr(el, 'data-ws-btn', '');
  });

  // ---------- 通用：给「没有名字的图标控件」补一个可核对的名字 ----------
  // 2026-11-15 owner 定案：**这不是某一站的问题，规则必须通用**。
  // 任何站点（原生 <button> / role=button / input[type=image|button|submit]）只要
  // 无障碍名为空，NVDA 按 B 只会念「按钮」，用户不知道它是什么。
  // 命名依据按「可核对程度」从高到低，全部是结构性/声明性信号，不靠猜站点：
  //   ① 控件自身的 ARIA 状态：aria-haspopup → 菜单；aria-expanded → 展开 / 收起；
  //   ② 同一父容器里**成对**出现的无名图标控件 + 容器语义：
  //      容器含 carousel/swiper/slider/轮播 → 上一张 / 下一张；
  //      容器含 pagination/pager/paging/分页 → 上一页 / 下一页；
  //   ③ 类名 / id / data-* 里的**通用控件词**（close、search、play、fullscreen…），
  //      只按单词边界匹配，避免 preview 命中 prev；
  //   ④ 兜底：命名为「未命名」——明确告诉用户这是站点没给名字，
  //      而不是让读屏只念一个不知道为什么出现的「按钮」。
  // 已有任何名字来源（aria-label / labelledby / title / 可见文本 / 子元素 alt 或
  // aria-label）的控件一律不动（S3/S4）。
  const ZW_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const CONTROL_SEL = 'button, [role="button"], input[type="image"], input[type="button"], input[type="submit"]';
  const hasNameSource = (el) => {
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    if (el.hasAttribute('aria-labelledby')) return true;
    if ((el.getAttribute('title') || '').trim()) return true;
    if (el.tagName === 'INPUT') {
      if ((el.getAttribute('alt') || '').trim()) return true;
      if ((el.getAttribute('value') || '').trim()) return true;
      return false;
    }
    let txt = '';
    try { txt = el.innerText || ''; } catch { txt = el.textContent || ''; }
    if (txt.replace(ZW_RE, '').trim()) return true;
    return !!el.querySelector(
      'img[alt]:not([alt=""]), svg[aria-label]:not([aria-label=""]), ' +
      '[aria-label]:not([aria-label=""]), [title]:not([title=""])'
    );
  };
  const visible = (el) => {
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch { /* 断开子树按可见处理 */ }
    return !el.closest('[aria-hidden="true"]');
  };
  const ancestorHint = (el, depth = 4) => {
    const parts = [];
    let n = el.parentElement;
    for (let d = 0; n && d < depth; d++, n = n.parentElement) {
      parts.push(n.className || '', n.id || '',
        n.getAttribute?.('role') || '', n.getAttribute?.('aria-roledescription') || '',
        n.getAttribute?.('aria-label') || '');
    }
    return parts.join(' ');
  };
  // 通用控件词表：英文按**完整单词**（class/id/data-* 拆词后比对，避免 preview→prev 误伤），
  // 中文按子串。顺序 = 从具体到宽泛（page/top 类先判，避免 back 抢先命中）。
  const WORDS = [
    ['关闭', ['close', 'dismiss', 'cancel']],
    ['搜索', ['search', 'query']],
    ['全屏', ['fullscreen']],
    ['播放', ['play']],
    ['暂停', ['pause']],
    ['静音', ['mute', 'muted']],
    ['音量', ['volume']],
    ['分享', ['share']],
    ['下载', ['download']],
    ['设置', ['settings', 'setting', 'config']],
    ['刷新', ['refresh', 'reload']],
    ['订阅', ['subscribe']],
    ['点赞', ['like', 'upvote']],
    ['评论', ['comment']],
    ['首页', ['home']],
    ['菜单', ['menu', 'hamburger']],
    ['更多', ['more']],
    ['展开', ['expand']],
    ['收起', ['collapse', 'collapsed']],
    ['上一页', ['prevpage', 'pageprev']],
    ['下一页', ['nextpage', 'pagenext']],
    ['上一个', ['prev', 'previous', 'back', 'backward']],
    ['下一个', ['next', 'forward']],
  ];
  const CN_WORDS = [
    ['上一页', ['上一页']], ['下一页', ['下一页']],
    ['上一张', ['上一张']], ['下一张', ['下一张']],
    ['回到顶部', ['回到顶部', '返回顶部']],
    ['关闭', ['关闭', '关掉']], ['搜索', ['搜索']], ['全屏', ['全屏']],
    ['上一个', ['上一个']], ['下一个', ['下一个']],
    ['播放', ['播放']], ['暂停', ['暂停']], ['静音', ['静音']], ['音量', ['音量']],
    ['分享', ['分享']], ['下载', ['下载']], ['设置', ['设置']], ['菜单', ['菜单']],
    ['刷新', ['刷新']], ['订阅', ['订阅']], ['点赞', ['点赞']], ['评论', ['评论']],
    ['首页', ['首页']], ['展开', ['展开']], ['收起', ['收起']],
  ];
  const keywordName = (el) => {
    const raw = [
      el.getAttribute('class') || '', el.id || '',
      ...Array.from(el.attributes || []).filter((a) => a.name.startsWith('data-')).map((a) => a.value),
    ].join(' ').toLowerCase();
    if (!raw) return '';
    const tokens = raw.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean);
    for (const [name, words] of WORDS) {
      if (words.some((w) => tokens.includes(w))) return name;
    }
    for (const [name, words] of CN_WORDS) {
      if (words.some((w) => raw.includes(w))) return name;
    }
    return '';
  };
  const structuralName = (el) => {
    const parent = el.parentElement;
    if (!parent) return '';
    const peers = [...parent.children].filter((x) => x.matches?.(CONTROL_SEL) && !hasNameSource(x) && visible(x));
    if (peers.length !== 2) return '';
    const first = peers[0] === el;
    const hint = ancestorHint(el);
    if (/carousel|swiper|slider|轮播/i.test(hint)) return first ? '上一张' : '下一张';
    if (/pagination|pager|paging|分页/i.test(hint)) return first ? '上一页' : '下一页';
    return '';
  };
  // ⚠️ 先收集、再**全部算完**、最后写：边算边写会让成对控件里第一个被命名后
  // 从「无名」名单里消失，第二个的兄弟计数从 2 变 1（2026-11-15 夹具实测 next=下一个）。
  const controls = [];
  for (const r of rootList) {
    if (!r) continue;
    try {
      if (r.matches?.(CONTROL_SEL)) controls.push(r);
      controls.push(...r.querySelectorAll(CONTROL_SEL));
    } catch { /* 断开子树跳过 */ }
  }
  const planned = [];
  for (const el of controls) {
    if (!el.isConnected || hasNameSource(el) || !visible(el)) continue;
    if (el.closest('[data-ws-ignore-obs]')) continue;
    if (modal && !modal.contains(el)) continue;
    const popup = (el.getAttribute('aria-haspopup') || '').trim();
    if (popup && popup !== 'false') { planned.push([el, '菜单']); continue; }
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') { planned.push([el, '收起']); continue; }
    if (expanded === 'false') { planned.push([el, '展开']); continue; }
    const structural = structuralName(el);
    if (structural) { planned.push([el, structural]); continue; }
    planned.push([el, keywordName(el) || '未命名']);
  }
  for (const [el, name] of planned) {
    if (name) ctx.setAttr(el, 'aria-label', name);
  }
};
