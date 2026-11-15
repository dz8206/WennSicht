// P1：图表转表格 / 图表无障碍描述（BP P1「检测 ECharts/Chart.js 实例，提取配置数据，
// 生成可读文本表格 + 趋势总结」）
//
// ⚠️ 与 S8 的冲突与取舍（2026-09-28 用户拍板）：
//   S8 禁止向页面主世界注入脚本，因此 `echarts.getInstanceByDom(dom).getOption()`
//   这类"直接读配置数据"的路径在隔离世界**不可达**；画布渲染的图表在 DOM 里
//   也不含任何数值（只有 <canvas>）。故本模块按三层策略实现（宁缺勿假）：
//
//   1) **复用**（零 AI、零改动）：容器已有无障碍名（aria-label/labelledby）、
//      页面自带 ECharts 无障碍摘要（role=img）、容器内已有数据表格或 figcaption
//      → 数据已在无障碍树里，扩展不碰（S3）。
//   2) **画布型**：canvas.toDataURL 取「渲染结果本身」→ 视觉模型**只说明
//      图表类型、横轴纵轴含义、整体趋势**，明令禁止编造数值；
//      注入时一律标注「AI推测，未获取原始数据」。
//      —— 不新增权限、不注入主世界、不截图（captureVisibleTab 属 BP 4.4 第 3 档，未决）。
//   3) **矢量型**（ECharts SVG 渲染等）：读 SVG 内的文字标签，生成一句标识（零 AI）。
//
// 注入方式：给画布/矢量图 `role="img"` + `aria-label="AI描述：…"`。
//   canvas/svg 本身没有可访问名称（不设的话屏幕阅读器读不到任何信息），
//   这与图片管线的 alt、SVG 图标的 aria-label 同一条实践（补缺失的描述，S4）。
//
// 失败与成本：**单页预算已移除**（`AI_BUDGET_PER_PAGE = Infinity`，2026-09-30 owner 拍板：
//   除「图片日限」外的一切预算限制全部取消，去重保留 —— 见 AGENT_MEMORY/README.md
//   「第十会话」条目。**不要把这里改回 3**，成本闸门在中转配额）。任何失败静默；
//   图表调用**不计入** ws_image_config 的图片额度（该额度由图片管线在内存中
//   累加写入，两处同时读写会互相覆盖计数，故不做双写）。
window.WS_CHART_TABLE = (() => {
  const AI_PREFIX = 'AI描述：';
  const UNCERTAIN_SUFFIX = '（AI不确定，仅供参考）';
  const SPECULATIVE_SUFFIX = '（AI推测，未获取原始数据）';
  const MARK = 'data-ws-chart';
  const AI_BUDGET_PER_PAGE = Infinity;
  const MIN_W = 120; // 画布小于此尺寸 → 视为迷你图/装饰，不处理
  const MIN_H = 60;
  const MAX_CANVAS_PX = 900; // 送模型前的长边上限（控费用与延迟）
  const MAX_BLOB_BYTES = 600 * 1024;
  const MAX_SVG_LABELS = 20; // 会话 80：12→20（复杂图表的长尾标签更完整，调用量不变）

  const CAPTCHA_RE = /captcha|verify|验证码|checkcode|vcode|geetest|recaptcha/i;
  // 强提示：只在明确是图表时才处理（宁缺勿假，避免把插画/图标当图表）
  const STRONG_RE = /chart|graph|plot|trend|echarts|highcharts|canvasjs|amcharts|charts?js/i;
  // 弱提示：中文命名习惯（需配合尺寸/标题判断）
  const WEAK_RE = /图表|趋势|走势|占比|统计图|数据图/i;

  let ctx = null;
  let stopped = true;
  let running = false;
  let aiAvailable = false;
  let budgetUsed = 0;
  const queue = [];
  let seen = new WeakSet();
  let processed = new WeakSet();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadConfig() {
    const ai = (await chrome.storage.local.get('ws_ai_config')).ws_ai_config || {};
    // 与图片管线一致：主开关 + 接口 + 视觉模型（读键走 WS_AI_SLOTS，含旧名 main/back
    // 回退；密钥本体只在 SW 侧解密）
    // v0.2 第 8 项：敏感站点（政务/医疗/金融）默认不外发图表画面
    aiAvailable =
      window.WS_AI_SLOTS?.enabled?.(ai) === true &&
      window.WS_AI_SLOTS?.visionReady?.(ai) === true &&
      window.WS_AI_PRIVACY?.allowed?.() !== false;
  }

  // ---------- 候选识别 ----------

  // 元素自身及三层祖先的 class/id/aria-label（图表容器通常带 chart/trend/echarts 之类命名）
  function hintText(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && depth < 3; depth++) {
      parts.push(node.getAttribute?.('class') || '', node.id || '', node.getAttribute?.('aria-label') || '');
      node = node.parentElement;
    }
    return parts.join(' ');
  }

  function nearestHeading(el) {
    let node = el.closest('figure, section, article, div, li, td');
    for (let depth = 0; node && depth < 3; depth++) {
      const h = node.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
      if (h) return (h.textContent || '').replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      node = parent ? parent.closest('figure, section, article, div, li, td') : null;
    }
    return '';
  }

  function sizeOf(el) {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width) || 0, h: Math.round(r.height) || 0 };
  }

  // 是否值得作为图表处理（只做识别，不做任何改动）
  function isCandidate(el) {
    // ECharts 自己打在容器上的属性，最可靠（canvas / svg 渲染都会有）
    if (el.hasAttribute('_echarts_instance_')) return true;

    const tag = el.tagName.toLowerCase();
    const hint = hintText(el);
    if (tag === 'canvas') {
      if (CAPTCHA_RE.test(hint)) return false;
      const { w, h } = sizeOf(el);
      if (w < MIN_W || h < MIN_H) return false; // 迷你图/图标画布
      if (STRONG_RE.test(hint) || WEAK_RE.test(hint)) return true;
      // 命名不明显时，看所在区块的标题是否在讲图表
      const heading = nearestHeading(el);
      return !!heading && (WEAK_RE.test(heading) || STRONG_RE.test(heading));
    }
    if (tag === 'svg') {
      // SVG 太容易与插画混淆，只认强提示
      return STRONG_RE.test(hint);
    }
    return false;
  }

  // 容器 → 真正承载图表的元素（画布优先，其次矢量图，最后容器本身）
  function targetOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas' || tag === 'svg') return el;
    return el.querySelector('canvas') || el.querySelector('svg') || el;
  }

  const CHART_SELECTOR = '[_echarts_instance_], canvas, svg';

  function collect() {
    const out = [];
    const push = (el) => {
      const target = targetOf(el);
      if (target && isCandidate(target)) out.push(target);
    };
    for (const el of document.querySelectorAll(CHART_SELECTOR)) push(el);
    return out;
  }

  // ---------- 护栏 ----------

  // 已有信息 → 复用，不动（S3）。返回 true 表示"这个图表已经能被读到"
  function alreadyAccessible(el) {
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    if (el.hasAttribute('aria-labelledby')) return true;
    if ((el.getAttribute('title') || '').trim()) return true;
    const holder = el.closest('[_echarts_instance_]') || el.parentElement;
    if (!holder) return false;
    // 页面自带的 ECharts 无障碍摘要
    if (holder.querySelector('[role="img"][aria-label], [role="img"][aria-labelledby]')) return true;
    // 页面自带数据表格 / 图注
    if (holder.querySelector('table')) return true;
    const cap = holder.querySelector('figcaption');
    if (cap && (cap.textContent || '').trim().length >= 4) return true;
    return false;
  }

  function eligible(el) {
    if (!el || el.hasAttribute(MARK)) return false; // 幂等
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]') || el.closest('[data-ws-hidden]')) return false;
    if (el.closest('[data-ws-ignore-obs]')) return false; // 扩展自身注入物
    if (el.getAttribute('role') === 'img' && (el.getAttribute('aria-label') || '').trim()) return false; // 图片管线已处理
    if (CAPTCHA_RE.test(hintText(el))) return false; // S7 验证码不处理
    return !alreadyAccessible(el);
  }

  // ---------- 注入 ----------

  function inject(el, text) {
    ctx.setAttr(el, 'role', 'img');
    ctx.setAttr(el, 'aria-label', text);
    ctx.setAttr(el, MARK, '1');
  }

  function chartContext(el) {
    const heading = nearestHeading(el);
    const holder = el.closest('figure, section, div, li, td') || el.parentElement;
    const text = holder ? (holder.textContent || '').replace(/\s+/g, ' ').trim() : '';
    const combined = [heading, text].filter(Boolean).join('；');
    return window.WS_SANITIZE ? window.WS_SANITIZE.context(combined, 80) : combined.slice(0, 80);
  }

  function clip(text, maxLen) {
    return window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(text, maxLen) : String(text || '').slice(0, maxLen);
  }

  // ---------- 画布取图（降采样 + PNG，文字更清晰） ----------

  function toBase64(u8) {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function canvasToDataUrl(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return null;
    const scale = Math.min(1, MAX_CANVAS_PX / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const off = new OffscreenCanvas(tw, th);
    const c = off.getContext('2d');
    c.drawImage(canvas, 0, 0, tw, th); // 被跨域内容污染的画布会在这里抛错 → 上层放弃
    const blob = await off.convertToBlob({ type: 'image/png' });
    if (!blob || blob.size > MAX_BLOB_BYTES) return null;
    return `data:image/png;base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`;
  }

  // ---------- 矢量图：只读文字标签（零 AI，不猜数值） ----------

  function svgLabels(svg) {
    const out = [];
    for (const t of svg.querySelectorAll('text, tspan')) {
      const s = (t.textContent || '').replace(/\s+/g, ' ').trim();
      if (!s || s.length > 20) continue;
      if (!out.includes(s)) out.push(s);
      if (out.length >= MAX_SVG_LABELS) break;
    }
    return out;
  }

  // ---------- 单条处理 ----------

  async function processOne(el) {
    if (!eligible(el)) return;
    const tag = el.tagName.toLowerCase();

    // 矢量型：零 AI，只列标签
    if (tag === 'svg') {
      const labels = svgLabels(el);
      if (labels.length < 2) return; // 读不到有效标签就不注入噪音
      inject(el, `图表：包含标签「${labels.join('、')}」；具体数值未提供`);
      return;
    }

    // 画布型：需要视觉模型
    if (!aiAvailable || budgetUsed >= AI_BUDGET_PER_PAGE) return;
    budgetUsed++;

    let dataUrl;
    try {
      dataUrl = await canvasToDataUrl(el);
    } catch {
      return; // 画布被污染 / 无法读取 → 保持原样
    }
    if (!dataUrl) return;

    let res;
    try {
      res = await ctx.describeImage({ dataUrl, context: chartContext(el), kind: 'chart' });
    } catch {
      return; // 取图或调用失败：保持原样，不注入噪音
    }
    const desc = clip(res.description, 120);
    if (!desc) return;
    inject(el, AI_PREFIX + desc + (res.confident ? SPECULATIVE_SUFFIX : UNCERTAIN_SUFFIX));
  }

  // ---------- 队列 ----------

  function enqueue(el) {
    if (stopped || !el || !el.isConnected) return;
    if (seen.has(el) || processed.has(el)) return;
    seen.add(el);
    queue.push(el);
    run();
  }

  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && queue.length) {
        const el = queue.shift();
        if (processed.has(el)) continue;
        processed.add(el);
        try {
          await processOne(el);
        } catch {
          // 单个图表失败不影响其余
        }
        // 画布登记指纹（重描抽查基线；见 verifyFresh 注释）
        if (el.tagName === 'CANVAS' && el.isConnected) {
          fingerprints.set(el, canvasFingerprint(el));
          if (!processedList.includes(el)) processedList.push(el);
        }
        await sleep(120);
      }
    } finally {
      running = false;
    }
  }

  function scan(roots) {
    if (stopped || !ctx) return;
    const rootList = Array.isArray(roots) && roots.length ? roots : [document];
    for (const r of rootList) {
      if (!r || !r.isConnected) continue;
      if (r.matches?.(CHART_SELECTOR)) enqueue(targetOf(r));
      for (const el of r.querySelectorAll?.(CHART_SELECTOR) || []) enqueue(targetOf(el));
    }
  }

  // ---------- 内容指纹重描（2026-11-03 会话 45 · 缺口 #11） ----------
  // 旧实现 seen/processed 一次定终身：canvas 数据更新后描述停留在旧图（陈旧=错误信息）。
  // 描述完成时存 64px 降采样指纹；verifyFresh()（spa-watcher 增量批调用）对已处理 canvas
  // 抽查重采样，指纹变了且每图重描 <REDESC_MAX 次 → 重新入队。指纹取不到（tainted canvas /
  // 尺寸 0）→ 跳过该图检查：无法判定就保持原样（宁缺勿假）。
  const REDESC_MAX = 3; // 会话 80：2→3（数据更新频繁的图表多跟一轮，增量调用量很小）
  const fingerprints = new WeakMap(); // canvas → 指纹
  const redescCount = new WeakMap();  // canvas → 已重描次数
  const processedList = [];           // 已处理 canvas 登记表（抽查轮转用；stop 时清空）

  function canvasFingerprint(el) {
    try {
      const w = el.width || 64;
      const h = el.height || 64;
      const c = document.createElement('canvas');
      const scale = Math.min(1, 64 / Math.max(w, h, 1));
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      const g = c.getContext('2d');
      g.drawImage(el, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let hash = 0x811c9dc5;
      for (let i = 0; i < d.length; i += 16) { // 抽样 1/16 字节：足以区分重绘，成本忽略
        hash ^= d[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return String(hash);
    } catch {
      return null; // tainted canvas / 已断开：无法判定
    }
  }

  function verifyFresh(maxCheck = 5) {
    if (stopped || !ctx) return;
    let checked = 0;
    for (let i = 0; i < processedList.length && checked < maxCheck; i++) {
      const el = processedList[i];
      if (!el.isConnected) {
        processedList.splice(i, 1);
        i--;
        continue;
      }
      const fp = canvasFingerprint(el);
      if (fp == null) continue; // 判不了的不消耗本轮抽查名额
      checked++;
      if (fingerprints.get(el) === fp) continue;
      const n = redescCount.get(el) || 0;
      if (n >= REDESC_MAX) continue; // 动画类 canvas：本页不再自动重描（防播报风暴）
      redescCount.set(el, n + 1);
      fingerprints.set(el, fp); // 以新内容为基线；重描完成后 run() 会再次更新
      processed.delete(el); // 允许重新入队
      seen.delete(el);
      enqueue(el);
    }
  }

  // ---------- 生命周期 ----------

  async function start(context) {
    if (!stopped) return;
    ctx = context;
    stopped = false;
    budgetUsed = 0;
    queue.length = 0;
    processedList.length = 0;
    // 关闭增强会还原注入属性，重开时必须忘记"已处理"（同 link-intent.js）
    seen = new WeakSet();
    processed = new WeakSet();

    await loadConfig();
    // 画布型需要视觉模型；没有 AI 时仍可处理矢量型标签（零成本能力）
    const targets = collect();
    // 矢量图零 AI、瞬时完成——先入队。否则一个慢的画布视觉调用（可达数十秒）
    // 会把紧邻其后的 SVG 标签注入一起堵住，用户要等网络才读到本地就能算出来的信息。
    for (const el of targets) {
      if (el.tagName.toLowerCase() === 'svg') enqueue(el);
    }
    if (aiAvailable) {
      for (const el of targets) {
        if (el.tagName.toLowerCase() !== 'svg') enqueue(el);
      }
    }
  }

  function stop() {
    stopped = true;
    queue.length = 0;
    processedList.length = 0;
    ctx = null;
  }

  return {
    start,
    stop,
    observeNew: (els) => {
      if (stopped) return;
      for (const el of els || []) {
        if (!el || !el.isConnected) continue;
        if (el.matches?.('[_echarts_instance_], canvas, svg')) enqueue(targetOf(el));
        for (const child of el.querySelectorAll?.('[_echarts_instance_], canvas, svg') || []) enqueue(targetOf(child));
      }
    },
    isRunning: () => !stopped,
    verifyFresh,
  };
})();
