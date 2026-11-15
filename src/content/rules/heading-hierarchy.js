// 标题层级修复（2026-11-03 会话 45 · 缺口 #8）：只修「层级」，不动标签、不改文本。
//
// 修什么：
//   1) 跳级：上一级是 1、下一个直接是 h4 → 给 h4 补 aria-level="2"（显示层级压平，
//      H 键导航的层级播报恢复正常）；后续标题按「有效层级 +1」重新计。
//   2) 多 h1：第一个 h1 保留 1，其余 h1 降为 2。
//
// 怎么修（S3 合规）：**不删标签、不改 role**——原生 h1–h6 的语义保留，只叠加
// aria-level 覆盖显示层级（ARIA 规范允许 heading 的 aria-level 覆盖标签层级），
// 并打 data-ws-hlevel 标记自识。作者已写 aria-level 的标题一律不碰（S3）。
// 全部经 ctx.setAttr 写入，关闭增强由 journal 一键还原。
//
// 幂等：带 data-ws-hlevel 的标题按其 aria-level 作为有效层级参与计数，不重复修改。
// 增量：层级依赖全文档顺序（前文标题决定后文的有效层级），增量批次同样全文档跑；
// h1–h6 全文档查询很便宜（几十个量级），不需要子树近似。
window.WS_RULES = window.WS_RULES || {};

WS_RULES.headingHierarchy = async (ctx, roots) => {
  // roots 仅用于兼容规则签名；本规则永远全文档（见文件头「增量」说明）
  void roots;
  if (!document.body) return;

  const nativeLevel = (el) => {
    const m = /^H([1-6])$/.exec(el.tagName);
    return m ? Number(m[1]) : null;
  };

  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => {
    if (h.closest('[aria-hidden="true"]')) return false;
    try {
      const cs = getComputedStyle(h);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch {
      /* 计算样式失败按可见处理 */
    }
    return true;
  });
  if (heads.length < 2) return;

  let prev = 0; // 上一个有效层级（0 = 还没遇到第一个标题）
  const fixes = [];
  for (const h of heads) {
    const native = nativeLevel(h);
    if (native == null) continue;
    // 已被我们改过的：以标记的 aria-level 为有效层级（重复运行幂等）
    if (h.hasAttribute('data-ws-hlevel')) {
      prev = Number.parseInt(h.getAttribute('aria-level'), 10) || prev;
      continue;
    }
    // 作者已写 aria-level：语义是作者定的，不碰（S3），其值计入有效层级
    if (h.hasAttribute('aria-level')) {
      prev = Number.parseInt(h.getAttribute('aria-level'), 10) || prev;
      continue;
    }
    let want;
    if (prev === 0) {
      // 第一个标题：是 h1 就定为 1；不是 h1（页面直接从 h3 开始）也按原级保留，
      // 只把它当作后续计数的基准——第一颗标题不存在"跳级"问题
      want = native;
    } else if (native === 1 && prev > 1) {
      want = 2; // 多 h1：第一个之外降为 2
    } else if (native > prev + 1) {
      want = prev + 1; // 跳级压平
    } else {
      want = native; // 正常（≤ prev+1）：保留原级（升回更高级也允许，如 2→1 不动）
    }
    prev = want;
    if (want !== native) fixes.push({ el: h, level: want });
  }

  await ctx.forEachBatched(fixes, ({ el, level }) => {
    ctx.setAttr(el, 'aria-level', String(level));
    ctx.setAttr(el, 'data-ws-hlevel', '');
  });
};
