// v0.2 第 8 项：敏感站点分级 + 隐私门控（零 AI、纯本地判定）
//
// 做什么：政务 / 医疗健康 / 金融理财三类站点，页面内容天然敏感（身份、病情、账务），
// 默认**关闭一切对外发送**——不发 URL（S10 本就不发）、不发文本样本、不发图片字节。
// 页面规则修复（标题/地标/按钮语义/表单提示等本地能力）照常工作，不受影响。
//
// 判定两级（从严，宁缺勿假；本地完成，零网络）：
//   ① 域名强证据：gov.cn / hospital / 证券基金类域名等（见 HOST_RULES）；
//   ② 页面信号：标题 + meta description + og:site_name/description 中
//      同一类别命中 **≥2 个关键词**才判定（单个词不足以定性，避免误伤）。
// 命中后把结果登记到 ws_sensitive_sites（供设置页列出），默认 allowAI=false；
// 用户在设置页为该站点勾选「允许」后才放行。
//
// 与 S10 的关系：S10 管「不传 URL、零遥测」；本模块管「连页面内容也不传」——
// 是更严格的一层，两者不冲突。放行开关只对当前站点生效，逐站可控。
//
// 2026-10-24（owner）：**敏感站点默认「整页不处理」**——不再只是关 AI，而是连本地规则修复
// （标题/地标/伪控件/噪音…）默认都不做。理由：政务/医疗/金融页面的 DOM 被第三方改写，
// 用户无法分辨哪些是网站本来的样子，默认不动最安全。
//
// **闸门只在「全局启用」模式下生效**（同日 owner 给出六情形定案，详见 gateBlocked 注释）：
// 逐站模式里用户把站点加进列表、或当场按快捷键，都算「明确表示需要开启」⇒ 不拦。
// 全局模式下用户没有点名任何站点 ⇒ 敏感的默认关，需要他连按两次 Ctrl+Shift+Z 强制开启
// （见 content.js 的 confirmArmedAt）；强制结果落在 ws_sensitive_sites[origin].forceEnhance
// （设置页「敏感站点保护」列表可见/可撤），站点级持久：下次打开该站点直接就增强。
// 与 allowAI 刻意分开：**强制开启增强 ≠ 允许外发内容**，AI 仍按 allowAI 门控。
window.WS_AI_PRIVACY = (() => {
  const LABEL = { gov: '政务', medical: '医疗健康', finance: '金融理财' };

  let category = null;
  let allowed = true;
  let aiOn = false;
  let inited = null;
  // 用户在本站点显式强制开启过增强（ws_sensitive_sites[origin].forceEnhance）
  let forced = false;
  // 当前是「全局启用」模式吗？（诊断/回归用；闸门判定已改为看 optedIn）
  let globalOn = false;
  // 用户**点名过**这个站点吗？（自己开启过 或 此前强制开启过）—— 闸门的唯一依据
  let optedIn = false;

  // ① 域名强证据（等价于「这个站点的经营主体就是干这个的」）
  const HOST_RULES = [
    { cat: 'gov', re: /(^|\.)gov\.(cn|hk|mo|tw)$|(^|\.)gov$/i },
    {
      cat: 'medical',
      re: /hospital|yiyuan|jiankang|clinic|dxy\.com|haodf|guahao|chunyuyi|yxj\.org|120ask|39\.net|medlive|drugs\.com/i,
    },
    {
      cat: 'finance',
      re: /bank|jinrong|jrj\.com|eastmoney|10jqka|xueqiu|hexun|cnstock|sse\.com\.cn|szse\.cn|amac\.org\.cn|insurance|baoxian|zhengquan/i,
    },
  ];

  // ② 页面信号关键词（同一类别命中 ≥2 个才判定）
  const PAGE_WORDS = {
    gov: ['人民政府', '政务服务', '政府门户', '政府信息公开', '政务公开', '党建', '公安局', '税务局', '市场监督管理局', '街道办事处', '民政局', '卫生健康委', '教育局', '委员会', '管理局'],
    medical: ['医院', '卫生院', '诊所', '门诊', '住院', '预约挂号', '挂号', '科室', '用药', '药品', '药房', '体检', '医保', '疾病', '症状', '康复', '护理', '医学', '健康', '医生'],
    finance: ['证券', '股票', '基金', '期货', '理财', '保险', '银行', '股吧', '行情', '沪深', '指数', '投资', '资产管理', '信托', '金融'],
  };

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const metaContent = (sel) => {
    const el = document.querySelector(sel);
    return el ? clean(el.getAttribute('content')) : '';
  };

  // 纯函数：域名判定（单独导出，便于回归直接断言，不受当前页面 host 限制）
  function classifyHost(host) {
    const h = String(host || '').toLowerCase();
    for (const r of HOST_RULES) {
      if (r.re.test(h)) return r.cat;
    }
    return null;
  }

  // 页面信号判定：取命中数最多的类别，且至少 2 个关键词命中
  function classifyPage() {
    let text = '';
    try {
      text = clean(
        [
          document.title,
          metaContent('meta[name="description"]'),
          metaContent('meta[property="og:site_name"]'),
          metaContent('meta[property="og:description"]'),
        ].join(' ')
      );
    } catch {
      return null;
    }
    if (!text) return null;
    let best = null;
    let bestHits = 0;
    for (const [cat, words] of Object.entries(PAGE_WORDS)) {
      let hits = 0;
      for (const w of words) if (text.includes(w)) hits++;
      if (hits > bestHits) {
        bestHits = hits;
        best = cat;
      }
    }
    return bestHits >= 2 ? best : null;
  }

  function classify() {
    const own = classifyHost(location.hostname) || classifyPage();
    if (own) return own;
    // 子框架兜底（2026-10-24）：`allFrames:true` 下同源 iframe 里本文件也会跑，而子框架
    // 往往没有自己的 title/description ⇒ 上面两级全落空，于是「顶层是政务站、iframe 里
    // 照常跑增强并把内容送进 AI」——正是 2026-10-04 祖先框架修复想堵的那类漏洞。
    // 这里按祖先来源域名再判一次（域名强证据，纯本地、零网络）。
    // ancestorOrigins 的顺序不保证，故逐项判、任一命中即按该类别处理（隐私侧从严）。
    try {
      const ancestors = location.ancestorOrigins || [];
      for (let i = 0; i < ancestors.length; i++) {
        const origin = ancestors[i];
        if (!origin || origin === 'null') continue;
        let host = '';
        try {
          host = new URL(origin).hostname;
        } catch {
          continue;
        }
        const cat = classifyHost(host);
        if (cat) return cat;
      }
    } catch {
      // ancestorOrigins 不可用时仅按本框架判定
    }
    return null;
  }

  // 初始化（applyAll 前 await 一次）：判定类别 + 读放行开关 + 登记检测结果
  function init() {
    if (inited) return inited;
    inited = (async () => {
      category = classify();
      try {
        const stored = await chrome.storage.local.get([
          'ws_sensitive_sites',
          'ws_ai_config',
          'ws_global',
          'ws_active_sites',
        ]);
        const map = stored.ws_sensitive_sites || {};
        const rec = map[location.origin];
        // ①②分开：**类别判定按页面**（同一网站的普通栏目页不该被连坐），
        // 放行开关按站点（用户只需在设置页为该站点勾一次）。
        // 因此非敏感页面永远放行；敏感页面只有「显式允许」才放行（缺记录/损坏一律按敏感处理——隐私侧从严）
        allowed = !category || rec?.allowAI === true;
        // 2026-10-24：强制开启增强（站点级；与 allowAI 独立）
        forced = rec?.forceEnhance === true;
        globalOn = stored.ws_global === true;
        aiOn = !!stored.ws_ai_config?.enabled;
        // 2026-10-25 SOLE_TRUTH：「用户明确表示需要」= 他自己开启过这个站点
        // （`ws_active_sites[origin] === true`，含此前的「强制开启」）——**全局启用不算点名**
        // （全局是「所有网站」的兜底，不代表他点名了这个敏感站）。
        const perSite = (stored.ws_active_sites || {})[location.origin];
        optedIn = perSite === true || forced;
        // 「即使添加特例的时候不知道这是敏感」→ 直接按已放行处理，并把设置调成一致状态
        // （forceEnhance + allowAI）：这样设置页「敏感站点保护」列表里能看见、能一键撤销，
        // AI 也不会因为残留的 allowAI=false 而静默失效。
        const needAdopt = category && optedIn && (rec?.allowAI !== true || rec?.forceEnhance !== true);
        if (category && (rec?.category !== category || needAdopt)) {
          if (needAdopt) {
            allowed = true;
            forced = true;
          }
          map[location.origin] = {
            ...(rec || {}),
            category,
            detectedAt: rec?.detectedAt || Date.now(),
            ...(needAdopt ? { forceEnhance: true, allowAI: true, adoptedAt: Date.now() } : {}),
          };
          await chrome.storage.local.set({ ws_sensitive_sites: map });
        }
      } catch {
        // 存储读取失败：判定为敏感类别时按不允许处理（fail-closed）；非敏感页面照常
        allowed = !category;
        forced = false;
        optedIn = false;
      }
      return { category, allowed, aiOn, forced, optedIn };
    })();
    return inited;
  }

  // 敏感站点默认关闭闸门（2026-10-25 · owner SOLE_TRUTH 定案，逐条落码）。
  //
  // owner 原话：「敏感站点默认关闭，但是如果用户明确表示需要开启或者之前开启过（即使添加特例时候
  // 不知道这是敏感），直接开启并调整相关设置。」
  //
  // 判定只有一条：**敏感 && 用户没点名过这个站点 ⇒ 闸门生效（默认不处理）**。
  //   「点名过」= `ws_active_sites[origin] === true`（用户自己开过这个站）或 `forceEnhance`
  //   —— **全局启用不算点名**（那只是「所有网站」的兜底）。
  // 对应 owner 的七种情形（编号按他的原文）：
  //   ① 全局 + 非敏感                 → 不开闸：默认开启，不播敏感
  //   ② 全局 + 敏感 + 没开特例        → **开闸**：默认关闭 + 播敏感；连按两次 Ctrl+Shift+Z 强制开启
  //   ③ 全局 + 敏感 + 开了特例        → 不开闸：正常运行，不播敏感（optedIn 里含 forceEnhance）
  //   ④ 局部 + 该站已开 + 非敏感       → 不开闸：默认开启，不播敏感
  //   ⑤ 局部 + 该站已开 + 敏感         → 不开闸：默认开启，不播敏感（用户开过＝点名过）
  //   ⑥ 局部 + 不在列表 + 非敏感       → 不开闸：默认关闭且不播；按一次快捷键 → 开启 + 加入列表
  //   ⑦ 局部 + 不在列表 + 敏感         → **开闸**：默认关闭 + 播敏感；连按两次才开，然后加入列表
  // 注意 ⑤ 与 ⑦ 的区别只有「用户有没有开过这个站」——这正是 owner 那句「之前开启过」的字面含义。
  function gateBlocked() {
    return !!category && !optedIn;
  }

  // 用户在本站点强制开启增强：内存生效 + 落盘（设置页据此列出，可撤销）。
  // 刻意不动 allowAI —— 强制做本地修复不等于允许把内容发给 AI。
  async function forceEnhance() {
    forced = true;
    // 2026-10-25 SOLE_TRUTH：用户点名过 ⇒ 这个站按普通站点运行，**AI 也要能用**。
    // 只改 storage 不够：init() 已缓存（inited），本次会话里 allowed 还是 false，
    // 后面的图片描述/场景解析会被 assertAllowed 拦掉 —— 必须同时更新内存态。
    optedIn = true;
    allowed = true;
    try {
      const { ws_sensitive_sites: map = {} } = await chrome.storage.local.get('ws_sensitive_sites');
      const rec = map[location.origin] || {};
      map[location.origin] = {
        ...rec,
        ...(category ? { category } : {}),
        forceEnhance: true,
        allowAI: true, // 「直接开启并调整相关设置」：AI 跟着一起放开
        forceChangedAt: Date.now(),
      };
      await chrome.storage.local.set({ ws_sensitive_sites: map });
    } catch {
      // 落盘失败：本次仍强制开启（内存已置位），只是下次打开不会记住
    }
    return { category, forced: true };
  }

  // 用户把增强**关掉** ⇒ 撤回「点名」（2026-10-31 · owner 实测缺陷）。
  //
  // 背景：敏感站被强制开启后会写 `forceEnhance+allowAI`（设置页列表里出现一条「已放行」）。
  // 如果用户随后在本页按 Ctrl+Shift+Z 关掉增强，那条记录却留着 —— 设置页仍显示"已放行"，
  // 保护没恢复。owner 明确要求：**关掉 = 撤回放行，设置页要跟着恢复这个站点的保护**。
  // 只清敏感记录，不动 `ws_active_sites`（那由 `rememberState` 写 false，两条记录各司其职）。
  async function releaseOptIn() {
    if (!category) return { released: false };
    forced = false;
    allowed = false;
    optedIn = false;
    try {
      const { ws_sensitive_sites: map = {} } = await chrome.storage.local.get('ws_sensitive_sites');
      const rec = map[location.origin];
      if (rec && (rec.forceEnhance === true || rec.allowAI === true)) {
        map[location.origin] = { ...rec, forceEnhance: false, allowAI: false, releasedAt: Date.now() };
        await chrome.storage.local.set({ ws_sensitive_sites: map });
      }
    } catch {
      // 落盘失败：内存已撤回，本次仍按"已关"运行；下次打开会重新判定
    }
    return { released: true };
  }

  // 开启增强时的一句隐私提示。
  //
  // 2026-10-25 SOLE_TRUTH：**放行后一律不播敏感**（owner 情形 ③⑤：「正常运行，不播报敏感」）。
  // 未放行的敏感站根本不会激活（闸门拦下，播的是「默认关闭」那句），所以这里永远是空串。
  // 历史：2026-10-03 曾在「已允许」时补一句「本站点属于X类网站；已按你的设置允许智能功能」，
  // 那是在「放行后一片寂静、分类不可知」的旧模型下的补救；新模型下它有违「不播报敏感」，
  // 故撤掉。分类状态仍然可查：设置页「敏感站点保护」列表 + `WS_AI_PRIVACY.category()`。
  function notice() {
    return '';
  }

  return {
    init,
    notice,
    category: () => category,
    label: () => (category ? LABEL[category] : ''),
    allowed: () => allowed,
    // 2026-10-24：整页默认关闭闸门的判定与解除（见文件头）
    gateBlocked,
    forceEnhance,
    releaseOptIn,
    forced: () => forced,
    optedIn: () => optedIn,
    globalMode: () => globalOn,
    // 回归直用：纯函数 + 当前页判定结果
    classifyHost,
    classifyPage,
    LABEL,
  };
})();