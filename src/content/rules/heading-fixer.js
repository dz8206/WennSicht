// 阶段 1.4：标题层级修复（BP 4.2 第 4 步）
// 启发式：视觉上像标题（字号显著大于正文，或 class 名含 title/heading）
// 但语义上不是标题的元素，补充 role="heading" + aria-level，
// 让屏幕阅读器可按标题键（NVDA: H / 数字键）跳转。
//
// 护栏 S3：不覆盖已有语义 ——
//   - 原生 h1-h6 内部的元素不动（属于标题内容本身）
//   - 已有 role / aria-label / aria-labelledby 的元素不动
//
// 实测教训（2026-09-27）：仅凭「字号大 + 短文本」会大量误判，已补以下排除项：
//   - 纯装饰浮层（pointer-events:none / user-select:none，如页面水印、跟随光标的图标）
//   - 单字符符号文本（✦ ★ 等图形字符，无字母数字）
//   - 嵌套重复（<font><b>标题</b></font> 会被父子双双命中，导致重复朗读）
//   - aria-hidden 子树内（屏幕阅读器本来就不读，标注无意义且属于越界修改）
//   - 交互控件内部（按钮/链接里的文字被标标题会把控件读成标题）
//   - 未渲染元素（display:none / 零尺寸）
window.WS_RULES = window.WS_RULES || {};

WS_RULES.headings = async (ctx, roots) => {
  let bodySize = 16;
  try {
    bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  } catch {
    /* 保留默认 */
  }

  const CLASS_TITLE_RE = /(^|\b|-)(title|heading|headline|head)(\b|-|$)/i;
  const SEL = 'div, span, p, td, th, li, strong, b, em, font, center';
  // roots 为空 → 全文档；否则仅扫描新增子树（增量模式，roots 含子树自身）
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

  const hits = [];
  const selected = new Set(); // 已选中的元素，用于嵌套去重

  // 2026-11-03 会话 45（瀑布流性能）：候选逐个 getComputedStyle + getClientRects 是
  // 同步循环，数万候选的页面会把主线程卡死、读屏拿不到缓冲。两个约束：
  //   ① 每 500 个候选让出一帧（requestAnimationFrame）；
  //   ② 候选总量上限 8000（按文档序截断并留痕——超长页只处理前 8000 个候选元素）。
  const CHUNK = 500;
  const MAX_CANDIDATES = 8000;
  // 会话 70（owner：「不能因为网站体量而延迟播报」）：光限「个数」不够——维基百科 15.9k 节点
  // 每候选 getComputedStyle + getClientRects 是强制样式/布局计算，4000 个候选就要 ~3.7s，
  // 开启播报被它拖在后面。改按**时间预算**：每次扫描最多 ~400ms，到点停下并留痕
  // （新内容由 SPA 观察器增量再扫；重新开启会重扫）。普通页面远达不到预算，行为不变。
  const BUDGET_MS = 400;
  const tStart = performance.now();
  if (candidates.length > MAX_CANDIDATES) {
    candidates.length = MAX_CANDIDATES;
    console.warn(`[WennSicht] 标题候选超过 ${MAX_CANDIDATES}，仅处理文档序前 ${MAX_CANDIDATES} 个。`);
  }

  for (let ci = 0; ci < candidates.length; ci += CHUNK) {
    if (performance.now() - tStart > BUDGET_MS) {
      console.warn(
        `[WennSicht] 标题候选扫描达时间预算（${BUDGET_MS}ms），已扫 ${ci}/${candidates.length} 个候选，其余跳过（内容更新时会增量再扫）。`
      );
      break;
    }
    // 让出一帧；**后台标签页里 rAF 不触发**，50ms 定时器兜底防挂死（会话 70）
    if (ci > 0) {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (!done) {
            done = true;
            resolve();
          }
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
    for (const el of candidates.slice(ci, ci + CHUNK)) {
    // S3：原生标题内部不动
    if (el.closest('h1, h2, h3, h4, h5, h6')) continue;
    // S3：已有语义不动
    if (el.hasAttribute('role')) continue;
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) continue;
    // aria-hidden 子树：屏幕阅读器不读，标注意义不大且不应越界修改
    if (el.closest('[aria-hidden="true"]')) continue;
    // 交互控件内部的文字不标注：<button><span>提交</span></button> 里的 span 若被
    // 标成 heading，屏幕阅读器会把按钮读成标题，破坏控件语义（S3 精神：不破坏已有语义）
    if (
      el.closest(
        'button, a, label, select, option, summary, textarea, ' +
        '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]'
      )
    ) continue;

    // 嵌套去重：祖先已被选为标题（本次运行）或已是标题（此前运行/作者所写）时跳过，
    // 否则全量重扫或增量扫描会把标题内的子孙文字重复标注，导致重复朗读
    let nested = false;
    for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
      if (selected.has(anc) || anc.getAttribute('role') === 'heading') {
        nested = true;
        break;
      }
    }
    if (nested) continue;

    const text = (el.textContent || '').trim();
    if (!text || text.length > 60) continue; // 标题不该是长段落
    // 纯符号文本（图形字符、装饰性字符）不是标题
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    // 价格不是标题：真实站的大号红字价格（¥89、$1,299.00）字号轻松过阈值，
    // 但屏幕阅读器把价格念成"标题"是纯噪音（实测 index.html 暴露）
    if (/^[¥$€£￥]\s*[\d,]+(?:\.\d+)?\s*(?:元|块)?$/i.test(text)) continue;

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      continue;
    }
    // 未渲染的元素不标注
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!el.getClientRects().length) continue;
    // 纯装饰浮层：不可交互且不可选中（页面水印、跟随鼠标的装饰图标等）
    if (cs.pointerEvents === 'none' || cs.userSelect === 'none') continue;

    const size = parseFloat(cs.fontSize) || 0;
    const ratio = size / bodySize;

    const classish = (el.getAttribute('class') || '') + ' ' + (el.getAttribute('id') || '');
    const classHit = CLASS_TITLE_RE.test(classish);

    // 字号显著大于正文（≥1.5 倍），或 class 命中且略大（≥1.2 倍）
    if (!(ratio >= 1.5 || (classHit && ratio >= 1.2))) continue;

    // 估算层级：越大越接近一级
    let level = 3;
    if (ratio >= 2.2) level = 1;
    else if (ratio >= 1.8) level = 2;
    else if (classHit) level = 3;

    hits.push({ el, level });
    selected.add(el);
  }
  }

  await ctx.forEachBatched(hits, ({ el, level }) => {
    ctx.setAttr(el, 'role', 'heading');
    ctx.setAttr(el, 'aria-level', String(level));
    // tabindex="-1"（S1 合规：-1 不进 Tab 序，只是可编程聚焦）——2026-10-03 owner 实测
    // 定案的关键一笔：NVDA 浏览缓冲对「已有元素补 role」这种纯属性变化**不更新**
    //（owner：注入的伪按钮 B 能到、伪标题 H 与 F7 元素列表都没有——两者唯一差别就是
    // 伪按钮带 tabindex=0，其 focusable 状态变化会触发缓冲重取）。给伪标题补 -1
    // 产生同样的状态变化，NVDA 才能把它收进缓冲，H 导航与元素列表才能看到。
    // 作者已写 tabindex 的元素不动（S3）。
    if (!el.hasAttribute('tabindex')) ctx.setAttr(el, 'tabindex', '-1');
  });
};
