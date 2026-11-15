// P2：表格解析（BP P2「复杂表格转为线性可读描述」）
//
// 目标用户的真实困境：中文网站大量"视觉表格"用 <td> 画出来，没有任何表头语义，
// 屏幕阅读器逐格念"单元格 一月 单元格 40 单元格 +5%"——用户不知道每列是什么。
//
// 本模块做两件事（**零 AI、全本地**）：
//   1) 无表头语义 + 首行像表头 → 给首行的 <td> 补 `role="columnheader"`
//      （td 允许 columnheader 角色），让屏幕阅读器在浏览单元格时能报出列头；
//      同时给 <table> 补一句**结构描述**：`表格：4 行 3 列，表头「月份、销售额、同比」`
//      —— 这就是 BP 要求的"线性可读描述"，数据本身仍由原生表格导航读取，不复制一份。
//   2) 首行有 <th> 但没有 scope → 补 `scope="col"`（标准修法，NVDA 据此关联表头与单元格）。
//
// 为什么不做"整表线性化"：把数据整段念一遍会与原生表格导航重复、且长表会变成噪音；
// 结构与表头才是缺失的那一层（与标题层级修复同一思路：补语义，不改内容）。
//
// 保守边界（宁缺勿假）：
//   - 布局表格不碰：行数 < 3、或任何单元格里有表单控件/嵌套表格、或 role=presentation/none；
//   - 已有表头语义（th / role=columnheader|rowheader / headers 属性）一律不覆盖（S3）；
//   - 只改属性，不动文本、不动结构（S4 / BP 4.2「不修改任何文本」）；
//   - 首行必须"像表头"：全为非纯数字的短文本，且表格下方确实有数字数据。
window.WS_TABLE_PARSER = (() => {
  const MARK = 'data-ws-table';
  const HEADER_MARK = 'data-ws-table-header';
  const MAX_HEADER_LEN = 20;
  const MAX_HEADERS_IN_DESC = 8;

  let ctx = null;
  let stopped = true;
  let running = false;
  const queue = [];
  let seen = new WeakSet();
  let processed = new WeakSet();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 判定 ----------

  function rowsOf(table) {
    const out = [];
    for (const tr of table.querySelectorAll('tr')) out.push(tr);
    return out;
  }

  function cellsOf(tr) {
    return Array.from(tr.querySelectorAll('th, td'));
  }

  function textOf(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const NUMERIC_RE = /^[\s¥$€￥,.\-+%（）()]*\d[\d\s,.\-+%（）()]*$/;
  function isNumericText(t) {
    return !!t && NUMERIC_RE.test(t) && /\d/.test(t);
  }

  function hasHeaderSemantics(table) {
    if (table.querySelector('th')) return true;
    if (table.querySelector('[role="columnheader"], [role="rowheader"], [headers]')) return true;
    return false;
  }

  function hasFormControls(table) {
    return !!table.querySelector('input, select, textarea, button, [contenteditable="true"]');
  }

  // 布局表格识别（保守）：太矮、含控件、含嵌套表格、显式 presentation
  function looksLikeLayoutTable(table) {
    const role = (table.getAttribute('role') || '').toLowerCase();
    if (role === 'presentation' || role === 'none') return true;
    if (hasFormControls(table)) return true;
    if (table.querySelector('table')) return true;
    const rows = rowsOf(table);
    if (rows.length < 3) return true; // 1~2 行的表基本是排版/键值对
    const firstRowCells = rows[0] ? cellsOf(rows[0]).length : 0;
    if (firstRowCells < 2) return true;
    return false;
  }

  // 首行像表头：全部是短文本、非纯数字；且表格其余部分确实出现数字。
  // 2026-10-01 owner 实测反馈：价格列「899 元」带汉字单位 → 旧 NUMERIC_RE 不命中 →
  // 整表被判「数据区无数字」而不注入列头。中文表格的数值几乎总带单位（元/%/年/人），
  // 故数据区证据放宽为「纯数字 或 数字+单位」两种形态。
  const NUM_WITH_UNIT_RE = /^[\s¥$€￥,._\-+%（）()]*\d[\d\s,._\-+%（）()]*[\u4e00-\u9fff]{1,3}$/;
  function dataCellEvidence(t) {
    if (isNumericText(t)) return true;
    return NUM_WITH_UNIT_RE.test(t);
  }
  function firstRowLooksLikeHeader(rows) {
    const cells = cellsOf(rows[0]);
    if (cells.length < 2) return false;
    for (const c of cells) {
      const t = textOf(c);
      if (!t || t.length > MAX_HEADER_LEN) return false;
      if (isNumericText(t)) return false;
    }
    for (let i = 1; i < rows.length; i++) {
      for (const c of cellsOf(rows[i])) {
        if (dataCellEvidence(textOf(c))) return true;
      }
    }
    return false;
  }

  function headerNames(rows) {
    return cellsOf(rows[0])
      .map((c) => textOf(c))
      .filter(Boolean)
      .slice(0, MAX_HEADERS_IN_DESC);
  }

  // ---------- 处理 ----------

  function processOne(table) {
    if (stopped || !ctx || !table.isConnected) return;
    if (table.hasAttribute(MARK)) return;
    if (table.closest('[aria-hidden="true"]') || table.closest('[data-ws-hidden]')) return;
    if (table.closest('[data-ws-ignore-obs]')) return;

    const rows = rowsOf(table);
    const cols = rows[0] ? cellsOf(rows[0]).length : 0;
    if (!cols) return;

    // 规则 2：已有 <th> 但缺 scope → 补 scope="col"（仅首行）
    if (hasHeaderSemantics(table)) {
      const firstRowThs = rows[0] ? cellsOf(rows[0]).filter((c) => c.tagName === 'TH') : [];
      if (firstRowThs.length === cols && firstRowThs.every((th) => !th.hasAttribute('scope'))) {
        for (const th of firstRowThs) ctx.setAttr(th, 'scope', 'col');
        ctx.setAttr(table, MARK, '1');
        ctx.setAttr(table, HEADER_MARK, 'scope');
      }
      return; // 其余情况：表头语义已存在 → 不动（S3）
    }

    if (looksLikeLayoutTable(table)) return;
    if (!firstRowLooksLikeHeader(rows)) return;

    // 规则 1：补列头角色 + 结构描述
    for (const cell of cellsOf(rows[0])) {
      ctx.setAttr(cell, 'role', 'columnheader');
    }
    // 结构描述刻意不重复 caption：NVDA 读表时会先读 caption 再读 aria-description，
    // 描述里再报一遍表题 = 用户听到两遍（2026-10-01 owner 实测确认）；
    // 有 caption 时描述只报「行列表头」增量信息。
    const cap = (table.caption?.textContent || '').replace(/\s+/g, ' ').trim();
    const names = headerNames(rows);
    const lead = cap ? '结构' : '表格';
    const desc = `${lead}：${rows.length} 行 ${cols} 列${names.length ? `，表头「${names.join('、')}」` : ''}`;
    ctx.setAttr(table, 'aria-description', desc);
    ctx.setAttr(table, MARK, '1');
    ctx.setAttr(table, HEADER_MARK, 'cols');
  }

  // ---------- 队列 ----------

  function enqueue(table) {
    if (stopped || !table || !table.isConnected) return;
    if (seen.has(table) || processed.has(table)) return;
    seen.add(table);
    queue.push(table);
    run();
  }

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length) {
        const t = queue.shift();
        if (processed.has(t)) continue;
        processed.add(t);
        try {
          processOne(t);
        } catch {
          // 单个表格失败不影响其余
        }
        await sleep(40);
      }
    } finally {
      running = false;
    }
  }

  function scan(roots) {
    if (stopped || !ctx) return;
    const list = Array.isArray(roots) && roots.length ? roots : [document];
    for (const r of list) {
      if (!r || !r.isConnected) continue;
      if (r.tagName === 'TABLE') enqueue(r);
      for (const t of r.querySelectorAll?.('table') || []) enqueue(t);
    }
  }

  // ---------- 生命周期 ----------

  async function start(context) {
    if (!stopped) return;
    ctx = context;
    stopped = false;
    queue.length = 0;
    // 关闭增强会整体还原注入属性，重开时不能记着"已处理"（同其它管线）
    seen = new WeakSet();
    processed = new WeakSet();
    scan();
  }

  function stop() {
    stopped = true;
    queue.length = 0;
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
