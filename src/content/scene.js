// P1/P2 前置：决策模型场景解析（"基于智能场景解析的无障碍增强"的招牌能力）
//
// 做什么：增强开启后，对当前页面收集轻量信号，经决策模型调用模型（Decisions API）
// 一次性回答三个类型化问题：
//   page_type        —— 这是哪类页面（资讯/商品/表单流程/混合）
//   operation_difficulty —— 视障用户操作此页面的难度（Score 量表）
//   images_need_alt  —— 图片是否普遍缺替代文本
// 结果：polite 播报一句场景结论 + 存入 window.WS_SCENE 供页面摘要引用。
//
// 为什么用决策模型而不是文本模型：分类判定不需要生成文本——决策模型返回
// 类型化概率（可置信度门控），单次调用多问题，成本约为文本模型的 1/30。
//
// 失败语义：任何失败静默返回 null（场景解析是增值能力，绝不能影响规则修复）。
window.WS_SCENE = (() => {
  let ran = false;
  let scene = null;

  // 2026-11-03（owner）：4 种太宽泛——「资讯阅读」报出来跟没报一样。细化到 9 种，
  // 每种在摘要模板（summarizer.js TEMPLATES）里有对应的侧重说明。
  const TYPE_LABEL = {
    article: '资讯文章',
    list: '列表浏览',
    product: '商品详情',
    form_flow: '表单流程',
    login: '账号登录',
    home: '网站首页',
    docs: '文档查阅',
    video: '视频播放',
    mixed: '混合功能',
  };
  const DIFF_LABEL = ['容易操作', '需要一些努力', '非常困难'];

  // 轻量页面信号（纯本地收集，经 sanitize 后才出站）
  function collectSignals() {
    const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').length;
    const navs = document.querySelectorAll('nav, [role="navigation"]').length;
    const forms = document.querySelectorAll('form, input, select, textarea').length;
    const imgs = document.images.length;
    const imgsNoAlt = [...document.images].filter((i) => !i.hasAttribute('alt') || /^(?!\s*$).+\.(png|jpe?g|gif|webp|svg)$/i.test(i.getAttribute('alt') || '')).length;
    const buttons = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').length;
    const clickDivs = document.querySelectorAll('div[onclick], span[onclick], [cursor], [style*="cursor"]').length;
    return { headings, navs, forms, images: imgs, imgs_no_alt: imgsNoAlt, buttons, clickable_divs: clickDivs };
  }

  function textSample(maxLen) {
    const main = document.querySelector('main, article, [role="main"]') || document.body;
    // 回落 body 时跳过扩展自身注入 UI 与样板区（导航/页眉/页脚/侧栏/表单/脚本），
    // 否则正文样本常被菜单和 Cookie 提示占满，页面类型被判错（会话 80）。
    let t;
    if (main === document.body) {
      const excluded = new Set(document.querySelectorAll(
        'nav, header, footer, aside, form, script, style, noscript, [role="navigation"], [role="contentinfo"], [role="banner"], [data-ws-ignore-obs], [role="status"]'
      ));
      const parts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
            if (excluded.has(el)) return NodeFilter.FILTER_REJECT;
          }
          return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let total = 0;
      while (walker.nextNode() && total < maxLen * 2) {
        const s = walker.currentNode.nodeValue.replace(/\s+/g, ' ').trim();
        if (!s) continue;
        parts.push(s);
        total += s.length + 1;
      }
      t = parts.join(' ');
    } else {
      t = main.textContent || '';
    }
    t = t.replace(/\s+/g, ' ').trim();
    return window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(t, maxLen) : t.slice(0, maxLen);
  }

  // 公开给所有辅助技术的结构语义（角色 + 名称），不含 URL/正文/表单值。
  function publicRoles() {
    const out = [];
    const seen = new Set();
    const els = document.querySelectorAll('main, nav, header, footer, aside, form, [role]');
    for (const el of els) {
      const role = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase();
      if (!/^(main|navigation|banner|contentinfo|complementary|form|search|dialog|tablist|tabpanel|listbox|menu|article|region)$/.test(role)) continue;
      if (seen.has(role)) continue;
      const raw = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      const name = raw && window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(raw, 30) : raw;
      seen.add(role);
      out.push(name ? `${role}:${name}` : role);
      if (out.length >= 10) break;
    }
    return out;
  }

  // S10 合规（2026-09-28 修正；会话 80 owner 更新口径）：
  // 完整 URL（带 query/hash/数字 ID）仍然不发；只发「域名 + 路径模板」——路径是网站
  // 公开发布的信息，且查询参数/分享令牌已被剥离。另保留本地粗类别 path_hint。
  function pathHint() {
    const p = (location.pathname || '').toLowerCase();
    if (/product|item|goods|detail|sku|listing/.test(p)) return 'product_like';
    if (/article|news|post|blog|content|info|notice|zhinan/.test(p)) return 'article_like';
    if (/list|category|channel|search|result|query/.test(p)) return 'list_like';
    if (/login|register|signup|form|apply|book|order|submit/.test(p)) return 'form_like';
    if (p === '' || p === '/') return 'home';
    return 'other';
  }

  // ---------- 网站简介（2026-09-29 用户需求：开场描述要说出「这个网站是干什么的」） ----------
  //
  // page_type 只是粗分类（「混合功能页面」这类），对第一次来的用户帮助有限。
  // 站点的 og:site_name / meta description 是网站自己写的"我是干什么的"，
  // 本地提取拼一句追加在场景播报后面 —— 零 AI、零延迟、零外发（这些文本本来就
  // 会随 text_sample 发给模型，这里只用于页面内播报）。**新加不替代**：
  // 原场景播报句式一字不动；提取不到任何信号就完全不加这句。
  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function cleanIntro(text, maxLen) {
    // 零宽/不可见字符先删（站名里不该有空格停顿；cleanText 对正文是换成空格，
    // 那对文本样本无害，但对报名字/简介就是「零 宽书店」这种怪停顿）
    const stripped = String(text || '').replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '');
    const raw = window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(stripped, maxLen) : stripped.slice(0, maxLen);
    const t = raw.replace(/\s+/g, ' ').trim();
    // 整段命中注入句式时 cleanText 返回占位符——当空处理，绝不播报这种字符串
    return t === '[已过滤可疑指令]' ? '' : t;
  }

  // 描述截断：优先在句界（。！？；）断开；无句界则 48 字硬截并加省略号
  // （让听者知道后面还有内容，而不是以为介绍就这么一句）
  function trimDesc(s) {
    if (s.length <= 48) return s;
    const cut = s.slice(0, 48);
    const m = cut.match(/^[^。！？；]*[。！？；]/);
    if (m) return m[0];
    return cut.replace(/[，、：:;；]$/, '') + '…';
  }

  function siteIntro() {
    const name = cleanIntro(metaContent('meta[property="og:site_name"]'), 24);
    let desc =
      cleanIntro(metaContent('meta[name="description"]'), 80) ||
      cleanIntro(metaContent('meta[property="og:description"]'), 80);
    const title = cleanIntro(document.title || '', 80);
    // 描述就是标题的复制（不少站拿标题当 description）→ 没有信息量，丢弃
    if (desc && title && desc.slice(0, 20) === title.slice(0, 20)) desc = '';
    if (desc) desc = trimDesc(desc);
    return { name, desc };
  }

  function introClause() {
    const { name, desc } = siteIntro();
    // 句尾标点去重：描述自带的 。！？… 之后就不再补句号（避免「。。」）
    const end = (s) => (/[。！？…]$/.test(s) ? '' : '。');
    // 描述以站名开头（真实站常态，如「惠民优选网是…」）→ 不再重复报名字
    if (name && desc && !desc.startsWith(name)) return `网站「${name}」简介：${desc}${end(desc)}`;
    if (desc) return `网站简介：${desc}${end(desc)}`;
    if (name) return `网站「${name}」。`;
    return '';
  }

  async function run(ctx) {
    // v0.2：同源子框架不跑场景解析 —— 播报已在内容脚本侧被静音，这里再挡掉
    // 是为了不白花一次决策模型调用（一个页面 N 个框架 = N 次调用、N 倍费用）。
    if (window.top !== window) return null;
    // v0.2 第 8 项：敏感站点（政务/医疗/金融）默认不外发页面文本样本——
    // 场景解析要发送 title/text_sample，属最早一批可能出站的调用，必须在此拦下
    if (window.WS_AI_PRIVACY?.allowed?.() === false) return null;
    if (ran) return scene;
    ran = true;
    try {
      const cfg = (await chrome.storage.local.get('ws_ai_config')).ws_ai_config || {};
      // 只检查主开关；模型/密钥校验由 SW 侧 decide() 负责（WS_AI 不在内容脚本世界）
      // 读键走 WS_AI_SLOTS（含「存储里还没写 enabled」的出厂兜底，2026-11-03）
      if (window.WS_AI_SLOTS?.enabled?.(cfg) !== true) return null;

      const resp = await chrome.runtime.sendMessage({
        type: 'WS_AI_DECIDE',
        state: {
          title: window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(document.title || '', 120) : (document.title || '').slice(0, 120),
          // 本地推导的粗粒度路径类别（不是地址本身，见 pathHint 注释）
          path_hint: pathHint(),
          // 会话 80：公开的「域名 + 路径模板」（无 query/hash/数字标识），供判断页面类型
          page_path: window.WS_SANITIZE?.pathTemplate?.(location.href) || '',
          text_sample: textSample(800),
          signals: collectSignals(),
          // 公开给辅助技术的结构角色/名称（不含正文、URL、表单值）
          roles: publicRoles(),
        },
        questions: {
          page_type: {
            type: 'choice',
            instructions: '这个网页属于哪种类型？',
            criteria: {
              article: '以阅读一篇或几篇文章、资讯正文为主的页面',
              list: '列表/搜索结果/信息流：以浏览条目、挑选后点入为主的页面',
              product: '以单个商品的展示、参数与电商购买操作为主的页面',
              form_flow: '以表单填写、申请/下单/办事流程为主的页面',
              login: '登录、注册、找回密码等账号入口页',
              home: '网站首页/门户：以栏目导航、板块入口为主的页面',
              docs: '文档、帮助、条款等供查阅参考的页面',
              video: '以视频/音频播放为主的页面',
              mixed: '多种功能混合、难以归入以上任何一类的复杂页面',
            },
          },
          operation_difficulty: {
            type: 'score',
            instructions: '视障用户用屏幕阅读器操作这个页面的难度',
            criteria: ['容易操作', '需要一些努力', '非常困难'],
          },
          images_need_alt: {
            type: 'noul',
            instructions: '这个页面的图片是否普遍缺少无障碍替代文本、需要增强？',
            criteria: {
              true: '存在无 alt 或 alt 为文件名的图片',
              false: '图片替代文本完善',
            },
          },
        },
      });
      if (!resp?.ok) throw new Error(resp?.error || '决策调用失败');
      const answers = resp.answers;

      const pt = answers.page_type || {};
      const diff = answers.operation_difficulty || {};
      const alt = answers.images_need_alt || {};
      scene = {
        pageType: pt.choice || null,
        confidence: pt.confidence ?? null,
        difficulty: diff.score ?? null,
        imagesNeedAlt: alt.noul ?? null,
        siteIntro: siteIntro(),
      };

      // 播报：一句话场景结论（低置信度标注）+ 网站简介（本地提取，无则不加）。
      // 原句式保持不变（新加不替代）——简介永远只是追加在后面的一句。
      const label = TYPE_LABEL[scene.pageType] || '未知类型';
      const diffLabel =
        typeof scene.difficulty === 'number'
          ? DIFF_LABEL[Math.min(DIFF_LABEL.length - 1, Math.max(0, Math.round(scene.difficulty)))]
          : '';
      const lowConf = typeof scene.confidence === 'number' && scene.confidence < 0.6;
      const intro = introClause();
      ctx.announce(
        `场景解析：这可能是${label}页面，操作难度${diffLabel || '未知'}${lowConf ? '（解析置信度较低）' : ''}` +
          (intro ? `。${intro}` : ''),
        { boot: true } // 会话 51：页面加载开场句；普通刷新时不再重播
      );
      return scene;
    } catch (e) {
      // 失败也记录到状态（诊断用；不影响规则修复）
      scene = { error: String(e && e.message || e).slice(0, 140) };
      return scene;
    }
  }

  // introClause 一并导出：回归验证直接断言完整句式（纯函数，零 AI）
  return { run, get: () => scene, siteIntro, introClause };
})();
