// P2：表单辅助（BP P2「识别无标签输入框，结合上下文推断标签，逐步引导」）
//
// ⚠️ 与 BP 4.2「不触碰表单元素」的关系（本模块的红线）：
//   表单辅助**只读不写**——不设属性、不改 value、不动 DOM、不自动填写（S6 / S9）。
//   做法：当用户把焦点移到一个**没有可访问名称**的输入框时，用本地启发式从
//   页面上下文推断它是什么，并 polite 播报一句。零 AI、零 DOM 改动，因此一键关闭
//   后无需还原（本来就没改过任何东西）。
//
// 为什么值得做：政务/医院挂号类页面的"视觉标签"（表格左格文字、前面的 span）
//   对屏幕阅读器不构成名称，用户听到的是"编辑框 空白"——参考文献 BP 8.2 医院挂号系统。
//
// 判定"没有名称"的保守口径（任一存在即视为有名，不播报、不打扰）：
//   <label for> / 包裹式 <label> / aria-label / aria-labelledby / title / placeholder
//   （placeholder 按 accname 规范是兜底名称来源，NVDA 会读出来）
//
// 推断顺序（本地、可解释）：紧邻前文 → name/id 关键词词典 → 所在小节标题/legend
// 播报格式：「无标签输入框：推测是「手机号」（必填）」；推断不出则明说「无法判断用途」。
window.WS_FORM_HELPER = (() => {
  const MAX_SNIPPET = 20;
  const DEDUP_WINDOW_MS = 1500;

  // 提示比焦点朗读**晚一点**发出（2026-10-02 owner 耳听实测抓到）：
  // 原实现在 focusin 里直接写 live region（下一帧，约 16ms），与读屏刚开始的焦点朗读
  // 撞在一起。延后一点让「焦点 → 提示」的顺序确定下来；期间焦点已移走就作废
  // （用户连按 Tab 时不念上一个字段的旧提示）。
  // 2026-10-03 二轮定案：光延后救不了**错误提示**——NVDA 的 polite 队列会被下一次焦点
  // 事件整个清掉，而错误字段的焦点朗读最长（约 3 秒），用户 Tab 走时提示必丢。
  // 错误提示改走 ctx.announce(msg, { urgent: true }) 的临时打断式（见 onFocus 内注释）。
  const HINT_DELAY_MS = 320;

  // name/id/class 关键词 → 中文名（只放高置信度、含义明确的词）
  const NAME_MAP = [
    [/mobile|phone|tel(?:no)?/i, '手机号'],
    [/idcard|id_?card|identity|sfz|身份证/i, '身份证号'],
    [/e-?mail|mailbox/i, '邮箱'],
    [/zip|postcode|postal/i, '邮政编码'],
    [/address|addr|dizhi/i, '地址'],
    [/passwd|password|pwd/i, '密码'],
    [/captcha|verify_?code|vcode|checkcode/i, '验证码'],
    [/search|keyword|key_?word|\bkw\b|\bq\b/i, '搜索关键词'],
    [/username|user_?name|login/i, '用户名'],
    [/\bname\b|xingming/i, '姓名'],
    [/company|corp|org(?:anization)?/i, '单位名称'],
    [/amount|money|price|fee|je\b/i, '金额'],
    [/\bdate\b|birthday|birth/i, '日期'],
    [/\btime\b|hour|minute/i, '时间'],
    [/qq/i, 'QQ 号'],
    [/wechat|weixin|wx/i, '微信号'],
    [/number|count|quantity|\bnum\b/i, '数量'],
    [/remark|comment|message|content|desc/i, '备注说明'],
    [/title|subject/i, '标题'],
  ];

  const SKIP_TYPES = /^(?:button|submit|reset|hidden|image|file|color|range)$/i;

  let ctx = null;
  let stopped = true;
  let lastEl = null;
  let lastAt = 0;
  let pendingTimer = null;
  let pendingEl = null;

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function isTargetField(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag !== 'input') return false;
    if (el.type === 'file') return true; // 上传控件同样需要名称
    return !SKIP_TYPES.test(el.type || 'text');
  }

  // 是否已有可访问名称（保守：有一项就认为作者已处理）
  function hasAccessibleName(el) {
    if (norm(el.getAttribute('aria-label'))) return true;
    if (norm(el.getAttribute('aria-labelledby'))) return true;
    if (norm(el.getAttribute('title'))) return true;
    if (norm(el.getAttribute('placeholder'))) return true;
    if (el.id) {
      try {
        if (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
      } catch {
        // CSS.escape 不可用或 id 非法：退化为属性选择器容错
        if (document.querySelector(`label[for="${el.id.replace(/"/g, '')}"]`)) return true;
      }
    }
    if (el.closest('label')) return true;
    return false;
  }

  // 紧邻前文：前一个兄弟节点的文本，或父节点里排在它前面的短文本
  function adjacentText(el) {
    let prev = el.previousElementSibling;
    for (let hops = 0; prev && hops < 2; hops++, prev = prev.previousElementSibling) {
      const t = norm(prev.textContent);
      if (t && t.length <= MAX_SNIPPET) return t;
    }
    const parent = el.parentElement;
    if (!parent) return '';
    // 父节点内、本控件之前的文本（排除控件自身）
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
    let acc = '';
    let node;
    while ((node = walker.nextNode())) {
      if (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) {
        acc += ' ' + norm(node.nodeValue);
      }
    }
    const t = norm(acc);
    return t && t.length <= MAX_SNIPPET * 2 ? t : '';
  }

  function nameFromAttributes(el) {
    const hay = [el.getAttribute('name'), el.id, el.getAttribute('class'), el.getAttribute('autocomplete')]
      .filter(Boolean)
      .join(' ');
    if (!hay) return '';
    for (const [re, label] of NAME_MAP) {
      if (re.test(hay)) return label;
    }
    return '';
  }

  function sectionHeading(el) {
    let node = el.closest('fieldset, section, form, div, td, li');
    for (let depth = 0; node && depth < 3; depth++) {
      const h = node.querySelector('legend, caption, h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (h) {
        const t = norm(h.textContent);
        if (t && t.length <= MAX_SNIPPET) return t;
      }
      const parent = node.parentElement;
      node = parent ? parent.closest('fieldset, section, form, div, td, li') : null;
    }
    return '';
  }

  // 推断标签（纯本地、可解释）
  function inferLabel(el) {
    const adj = adjacentText(el);
    if (adj) return adj.replace(/[：:；;，,。.\s]+$/, '');
    const byName = nameFromAttributes(el);
    if (byName) return byName;
    return sectionHeading(el);
  }

  function isRequired(el) {
    return el.required === true || /^true$/i.test(el.getAttribute('aria-required') || '');
  }

  // ---------- v0.2：格式与错误提示（仍然只读：不写属性、不改值、不动 DOM）----------
  // 覆盖填表的两个卡点：① 不知道这框要什么形状；② 提交失败后不知道错在哪
  // —— 错误提示常写在页面顶部或红字里、且没做 aria-describedby 关联，用户听到的
  // 只有"编辑框 空白"。
  // 反噪音口径：格式提示只对**无名称**字段补（有标签的字段标签已说明用途）；
  // 错误提示对所有字段生效，但作者已关联 aria-describedby / aria-errormessage
  // 时不再重复播报（屏幕阅读器本来就会读）。
  const FORMAT_TEXT = { tel: '电话号', email: '邮箱地址', number: '数字', url: '网址' };

  function formatHint(el) {
    const bits = [];
    const t = String(el.type || '').toLowerCase();
    if (FORMAT_TEXT[t]) bits.push(FORMAT_TEXT[t]);
    else if (/^(numeric|tel|decimal)$/i.test(el.getAttribute('inputmode') || '')) bits.push('数字');
    const max = Number(el.getAttribute('maxlength'));
    if (Number.isFinite(max) && max > 0) bits.push(`最多 ${max} 个字`);
    const min = Number(el.getAttribute('minlength'));
    if (Number.isFinite(min) && min > 0) bits.push(`至少 ${min} 个字`);
    return bits.join('，');
  }

  // 错误提示：就近取材（同一行/同一块里的错误节点），取不到才回落到通用文案。
  // 归属容器（2026-10-02 owner 实测抓出）：旧实现 closest('…div') 会爬到整页级容器，
  // 把**别的字段**的错误串到本字段（f2 报出 f1 的「手机号格式不正确」）。改为向上找
  // 「只装着这一个字段」的最近容器——一旦容器里混入其它字段，错误节点就说不清是谁的。
  function errorScope(el) {
    let best = el.parentElement;
    let node = best;
    while (node && node !== document.body) {
      if (node.querySelectorAll('input, select, textarea').length > 1) break; // 混入其它字段 → 停在上一层
      best = node;
      node = node.parentElement;
    }
    return best;
  }
  function errorText(el) {
    const wired = norm(el.getAttribute('aria-describedby')) || norm(el.getAttribute('aria-errormessage'));
    if (wired) return ''; // 作者已把说明/错误挂在字段上，屏幕阅读器会自己读 → 不重复播报
    // 词首边界 + 词干前缀匹配：err*（覆盖 err / error / errmsg / errbox）、
    // invalid*、danger*、warn*（覆盖 warn / warning / warnmsg）。
    // ⚠️ 2026-10-01 owner 实测抓到：老正则 err[-_] 漏掉裸 class="err"（真实网站常见），
    // 导致明明有错误文案却走了兜底、播报成「当前有错误：当前有错误」。
    // ⚠️ 2026-10-09 再修（demo-site 复现 + Node 矩阵验证）：修 2026-10-01 时把 err 分支写成
    // err(?:[^a-z]|$)，而外层又要求一个分隔符 —— 等于并列要求「两个」分隔符，
    // 于是 err-msg / err_msg / errmsg / err-text / errbox / errorTip 这些真实站点高频写法
    // **全部漏配**，错误文案被丢弃、又退回兜底文案。改为词干前缀后以上写法全部命中。
    // camelCase 先拆词（myErrorTip → my Error Tip），避免词干前面是字母而被边界挡掉。
    // 取舍：由「整词相等」放宽为「词干前缀」，代价是 warnings-none 这类以词干开头的
    // 非错误类名也会命中；收益是 errbox/errmsg/invalidInput/warning-box 等高频写法不再漏配。
    // 危害有限——仍受下面 40 字长度上限和「只在本字段所在容器内取材」两道约束。
    const ERR_KEY_RE = /(?:^|[^A-Za-z0-9])(?:err|invalid|danger|warn)[a-z]*/i;
    const isErrKey = (s) => ERR_KEY_RE.test(String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
    const scope = errorScope(el);
    if (scope) {
      for (const cand of scope.querySelectorAll('[class],[id],[role="alert"]')) {
        const key =
          (cand.getAttribute('class') || '') +
          ' ' +
          (cand.getAttribute('id') || '') +
          ' ' +
          (cand.getAttribute('role') || '');
        if (!isErrKey(key) && cand.getAttribute('role') !== 'alert') continue;
        const t = norm(cand.textContent);
        // 太长的多半是整表单的错误汇总，套在每个字段上会误伤 → 丢弃
        if (t && t.length <= 40) return t;
      }
    }
    if (el.getAttribute('aria-invalid') === 'true') return '当前有错误';
    return '';
  }

  function cancelPending() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingEl = null;
  }

  // 延迟播报：新焦点会取消上一个待发提示；到点时焦点已不在就当用户已经走开。
  // urgent=true（含错误的提示）经同一 region 临时切 assertive——见上方注释。
  function scheduleHint(el, msg, urgent) {
    cancelPending();
    pendingEl = el;
    pendingTimer = setTimeout(() => {
      const target = pendingEl;
      cancelPending();
      if (stopped || !ctx || !target || document.activeElement !== target) return;
      ctx.announce(msg, urgent ? { urgent: true } : undefined);
    }, HINT_DELAY_MS);
  }

  function onFocus(event) {
    if (stopped || !ctx) return;
    const el = event.target;
    if (!isTargetField(el)) return;
    if (el.closest('[data-ws-ignore-obs]') || el.closest('[aria-hidden="true"]')) return;

    const named = hasAccessibleName(el);
    const err = errorText(el);
    if (named && !err) return; // 作者已处理且没有错误 → 不打扰（保持原口径）

    // 同一控件短时间内重复聚焦（例如来回 Tab）只播报一次
    if (el === lastEl && Date.now() - lastAt < DEDUP_WINDOW_MS) return;
    lastEl = el;
    lastAt = Date.now();

    let msg = '';
    let urgent = false;
    if (!named) {
      const label = inferLabel(el);
      const base = label ? `无标签输入框：推测是「${label}」` : '无标签输入框：无法判断用途';
      const bits = [];
      if (isRequired(el)) bits.push('必填');
      const fmt = formatHint(el);
      if (fmt) bits.push(fmt);
      msg = base + (bits.length ? `（${bits.join('，')}）` : '');
    }
    if (err) {
      // 2026-10-03 owner 拍板的口径：**错误提示必须被听到**，走临时打断式播报。
      // 依据：NVDA 的 polite 消息只会排队，下一次焦点事件会把队列整个清掉；错误字段的
      // 焦点朗读最长，用户 Tab 走时提示必被丢弃（CDP 实证消息已写入 region 却听不到）。
      // 不给字段挂 aria-describedby 是因为 BP 4.2 禁止触碰表单元素（本模块保持零写入）。
      // 代价：打断该字段自身的朗读（Shift+Tab 回来可重听）——owner 已知情并拍板。
      urgent = true;
      // 兜底文案与引导词同名时不再嵌套（「当前有错误：当前有错误」是口吃，不是信息）
      msg = msg ? `${msg}。当前有错误：${err}` : err === '当前有错误' ? err : `当前有错误：${err}`;
    }
    if (!msg) return;
    scheduleHint(el, msg, urgent);
  }

  function start(context) {
    if (!stopped) return;
    ctx = context;
    stopped = false;
    lastEl = null;
    lastAt = 0;
    document.addEventListener('focusin', onFocus, true);
  }

  function stop() {
    stopped = true;
    cancelPending();
    document.removeEventListener('focusin', onFocus, true);
    ctx = null;
  }

  return {
    start,
    stop,
    // 供回归验证直接断言推断逻辑（纯函数，零副作用）
    inferLabel,
    hasAccessibleName,
    isRunning: () => !stopped,
  };
})();
