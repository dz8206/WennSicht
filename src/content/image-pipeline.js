// 阶段 2：图片描述管线（BP 2.1/2.4/4.3/4.4）
//
// 分类顺序（BP 4.3）：
//   1) 装饰性图片（小尺寸 + 无交互上下文）→ 设空 alt，跳过，不调 AI
//   2) 功能性图标（位于按钮/链接内）→ **先查本地图标词典**；未命中才调 AI
//   3) 内容图片（正文区、尺寸较大）→ 调 VLM 生成描述
//   4) 无法判断 → 注入「图片，AI未识别」
//
// 关键安全约束：
//   S4  只补充**缺失**的图片描述，绝不覆盖作者已写好的 alt，
//       绝不修改按钮文本、链接文本、表单标签
//   S5  所有 AI 生成内容加前缀「AI描述：」；低置信度追加「（AI不确定，仅供参考）」
//   S7  验证码不处理
//   BP 3.1.2 关键操作图标若无法高置信度识别，输出「功能图标，无法确定」而不是猜测
//   ⚠️ owner 铁律（2026-10-02）：开启插件的网站上绝不能让 "imagexxx" 这类文件名垃圾
//   被读出来——图片取不到字节且推测也无线索时，注入「未知图片：网站图片无法加载」
//   （明确归因网站）；能推测出线索时优先周边文本推测。图标侧用「功能图标，无法确定」。
//
// 语音播报模型（2026-09-28 用户修订，最终版）：
//   ①页面总览开场（场景解析播报，scene.js；无场景结果时由本模块补「已开启页面增强。」）
//   → ②「正在为 N 张图片生成缺失的描述。」（确有 AI 生成时）
//   → ③生成期间不读任何图片：alt 延迟到批次结束统一注入（机制级静默，不靠自觉）
//   → ④「已为 N 张图片生成缺失的描述。」（全缓存/零 AI 页面报「图片描述已就绪（N 张）」）
//   ⑤此后描述才可被读出：NVDA 导航到图片自动读 alt（全盲用户的主路径，靠 G 键）。
//   ⑥悬停重听（2026-09-30 用户决策：**默认关闭**，设置页可开）——只对用鼠标的
//   低视力/明眼协作者有价值：真实鼠标停在 AI 描述图上 1 秒重听（滚动不会误触，
//   见 onDwellOver 门控），同一次悬停只读一次（移开再进入 = 重听）；键盘焦点落在
//   图上重听保留（focusin，不受此开关影响）。注意：开启悬停重听时，NVDA 自身
//   鼠标跟踪会在指针进入图片时立即读 alt（页面无法抑制）——要「只听一遍」需在
//   NVDA 设置→鼠标 关闭鼠标跟踪。
//   绝不逐张播报、绝不批量读描述全文。
//
// Token 纪律：
//   - 同一图片**跨刷新**永不重复生成：描述文本持久化到
//     ws_ai_descriptions[origin][src]（每源上限 400 条），刷新后直接注入缓存描述
//   - 2026-09-30 用户决策：单页静态图预算移除（每张图片都处理，顺序从上到下）；
//     调用限制 = 易变图每页 VOLATILE_LIMIT 次（会话 80：30）+ 图片描述每日上限
//     （插件页面设置，走 ws_ai_usage 当日累计；出厂默认不限制）
//
// 异步队列规则（2026-09-30 修订）：
//   并发工作池 16 路（混合 fallback：main 免费档 1 RPS 令牌桶 + back 付费档并行
//   溢出，整体吞吐 ≥ 2 张/秒）；任务按**文档序**从上到下出队（用户明确：图片是
//   重要内容，不跳着处理）；**全文档入队**——屏幕阅读器用户浏览模式读全文、
//   并不滚动，「视口外」对盲人用户不存在；IntersectionObserver 只留给懒加载
//   占位 / 仍在下载的图片；全程异步，绝不阻塞页面加载与屏幕阅读器。

window.WS_IMAGE_PIPELINE = (() => {
  const AI_PREFIX = 'AI描述：';
  const UNCERTAIN_SUFFIX = '（AI不确定，仅供参考）';
  const UNKNOWN_IMAGE = '图片，AI未识别';
  const UNKNOWN_ICON = '功能图标，无法确定';
  // 取不到字节且推测也无线索时的兜底标注（owner 铁律 2026-10-02：插件开启的网站上
  // 绝不能让 "imagexxx" 文件名垃圾被读出来）。明确归因网站，区别于 UNKNOWN_IMAGE
  // （图片加载了但 AI 没认出来）。不缓存——图片可能只是临时故障，下次刷新自愈。
  const UNREADABLE_IMAGE = '未知图片：网站图片无法加载';
  // BP 4.4 第 4 档：取不到图片字节时，用周边文本做推测描述，必须明确标注
  const SPECULATIVE_SUFFIX = '（AI推测，未直接查看图片）';

  const DECORATIVE_MAX = 32; // 小于此尺寸且无交互上下文 → 装饰性
  const ICON_MAX = 64; // 交互上下文内小于此尺寸 → 图标
  const CONTENT_MIN = 64; // 非交互且大于此尺寸 → 内容图
  const WORKER_COUNT = 16; // 并发工作池（会话 80：10→16，大页完成时间约 -30%~40%）：primary 前置档 1 RPS + default 默认档并行
  const CACHE_MAX_PER_ORIGIN = 400; // 每源缓存条目上限（FIFO）

  // ---------- 轮播 / 易变图（会话 68 · owner 三条拍板；会话 80 上限 10→30）----------
  // N=30：每页「易变图」重新描述的调用上界。只拦因 src 变更触发的重新描述，
  // 静态图完全不受限（owner 会话 64 定「图片日限默认不限制」，不得连带改动）。
  const VOLATILE_LIMIT = 30;

  // ⚠️ 面向用户的「覆盖度披露」文案（owner 2026-11-13 选 A 简短版）——**草案、待 owner 定稿**。
  // 文案铁律：只在情况真的发生时才念。改字只改这个对象，不碰任何逻辑。
  // quota / loadFailed 两句由既有播报负责（「今日图片描述额度已用完」「另有 N 张图片无法加载」），
  // 为避免同一事实念两遍，coverageMessage() 不重复拼接；此处保留全文供 owner 定稿与查询使用。
  const COVERAGE_TEXT = {
    cap: (n) => `本页图片较多，只描述了前 ${n} 张，其余没有描述。`,
    changedTooFast: '部分图片变化过快，无法生成描述。',
    cacheEvict: '本页图片过多，部分未生成描述。',
    nonBitmap: '部分背景图不生成描述。',
    quota: '今天的公益额度用完了，无法继续生成图片描述。',
    loadFailed: '部分图片加载失败，无法生成描述。',
    tail: '你听到的不是本页全部内容。',
    queryTitle: '图片描述覆盖度',
    // 用户主动问「哪些图没描述、为什么」时的本地直答（页面问答 / 布局地图查询）。
    qaHead: (seen, described) => `本页发现 ${seen} 张需要描述的图片，其中 ${described} 张有描述。`,
    qaReasons: (list) => `没有描述的：${list}。`,
    qaNone: '本页没有因为成本或技术原因跳过的图片。',
    qaReason: {
      cap: (n, limit) => `${n} 张因达到每页 ${limit} 张上限`,
      changedTooFast: (n) => `${n} 张因变化太快`,
      cacheEvict: (n) => `${n} 张因受缓存淘汰影响`,
      loadFailed: (n) => `${n} 张因加载失败`,
      quota: (n) => `${n} 张因额度用完`,
      nonBitmap: (n) => `${n} 张图源因无法处理`,
    },
  };

  // 缓存键规范化（会话 66/68）：URL 带 cache-buster（?t=… / &_=…）时每次轮换都是新键 ⇒
  // 缓存 0 命中、叠加日限不限后无界烧钱。只剥这些参数做**键**，真实取图仍用原始 src
  //（防盗链 / 签名 URL 不能被改）。不引入任何等待。
  const CB_PARAM_RE = /^(?:t|ts|_|_t|time|timestamp|cache|nocache|nonce|rnd|rand|random|v|ver|r|cb)$/i;

  function cacheKey(src) {
    // 会话 69：真实站点里 src 可能是 null / undefined / 数字 / SVGAnimatedString
    //（srcset、懒加载占位、畸形节点）。旧实现直接 src.includes 会抛 TypeError，
    // 而它在 processOne 的缓存查表处 ⇒ 单张图抛错虽被 worker 兜住，但会静默丢描述。
    // 非字符串一律原样返回（调用方按 falsy 处理），不抛、不改语义。
    if (typeof src !== 'string' || !src) return src;
    // 无查询串（含 data:/blob:）原样返回：URL.toString() 会规范化百分号编码，
    // 不能让缓存键被改写。相对地址用 location.href 兜底，保证纯函数也自洽。
    if (!src.includes('?')) return src;
    try {
      const u = new URL(src, location.href);
      if (!u.search) return src;
      const pairs = Array.from(u.searchParams.entries());
      const kept = pairs.filter(([k]) => !CB_PARAM_RE.test(k));
      if (kept.length === pairs.length) return src;
      u.search = new URLSearchParams(kept).toString();
      return u.toString();
    } catch {
      return src; // data:/blob: 等非 URL 形式原样返回
    }
  }

  // 懒图兜底清扫（2026-10-11 外测修复，sina/163 实测）：
  // 旧行为把懒加载图**只**交给 IntersectionObserver，回调里 `if (!isIntersecting) continue`
  // ⇒ 视口外的懒图永不处理。对明眼用户无碍（滚动就会加载），但本插件面向盲人：
  // NVDA 浏览模式读全文、**不滚动**，于是「首屏以下的懒图」全部静默未标注。
  // 实测（news.sina.com.cn）：25 张内容图缺 alt，其中 17 张在视口外；手动滚到底后
  // 这 25 张**全部**补上（已标 AI 37 → 62，内容图缺 alt 25 → 0）。
  // 修复：保留 observer 作为「尽早处理」通道，另加多次兜底清扫——仍未处理的懒图
  // 直接用 data-* 声明的真实地址入队，与视口彻底解耦（盲人用户不存在的概念，
  // 就不该是处理门控）。仍然是逐张、异步、16 路并发，不阻塞页面。
  // 会话 80：3 次 → 5 次（补 45s / 70s）。慢网、长页、SPA 迟到的图能补上；每次只扫 DOM、开销极小。
  const LAZY_SWEEP_MS = [5000, 12000, 25000, 45000, 70000];
  let lazySweepTimers = [];
  let pendingLazy = new Set(); // 已交给 observer、但仍未入队的图

  const CAPTCHA_RE = /captcha|verify|验证码|checkcode|vcode|geetest|recaptcha/i;

  // 跨刷新描述缓存按源分桶的键（ws_ai_descriptions[ORIGIN][src]）。
  // ⚠️ 每个内容脚本各自运行在IIFE 内，跨文件读不到彼此的局部变量，
  //    本文件用到的常量必须在本文件内声明（2026-09-28 实测：此处漏声明
  //    导致 start() 抛 ReferenceError，整条增强管线静默失效）。
  const ORIGIN = location.origin;

  let ctx = null;
  let stopped = true;
  let running = false;
  let paused = false;
  let limitExceeded = false;

  let observer = null;
  const queue = [];
  // ⚠️ 必须是 let + 在 stop() 里重建成新 WeakSet（WeakSet 没有 clear()）。
  // 2026-10-02 owner 实测抓出的真缺陷：这两个集合原先只声明一次、stop() 不清，
  // 于是「关增强再开」后，所有图片都被 seen/processed 挡住 → 验证码标注、坏图
  // floor、AI 短描述全部静默不注入（测试 5/10/11 连环失效的根因之一）。
  let seen = new WeakSet();
  let processed = new WeakSet();

  // 本页已成功描述的图片地址（会话内）+ 跨刷新持久缓存（按源分桶）
  const describedUrls = new Set();
  let describedCache = {}; // ws_ai_descriptions[ORIGIN]

  let aiAvailable = false;
  let dailyLimit = 0;
  // 2026-11-10：单靠 dailyLimit 表达不了「每天 0 次」——它原来 0 = 不限。新增 limitEnabled：
  // false ⇒ 不限；true ⇒ dailyLimit 就是上限（0 合法 = 一天一次都不调用）。
  let limitEnabled = false;
  let hoverReplay = false; // 悬停重听开关（2026-09-30 用户决策：默认关闭——全盲用户靠 G 导航读图，
  // 不需要悬停；此功能只对用鼠标的低视力/明眼协作者有价值，设置页可控）
  let focusReplay = true; // 键盘焦点落在图上重听（键盘路径，保持开启）
  let usage = null;
  let doneCount = 0;
  let describedCount = 0; // 真正注入了可听描述（缓存/词典/AI/推测）的图片数——装饰图不计
  let failed = 0;
  let lastAiError = ''; // 本轮最近一次 AI 失败原因（诊断留痕 + 失败播报文案判据）
  let aiQueued = 0; // 本轮进入 AI 队列的数量（进度播报的 t）
  let aiSettled = 0; // 本轮已生成完成（成功+失败）的 AI 任务数（进度播报）
  let aiOk = 0; // 本轮成功拿到描述的 AI 任务数
  // 会话 80（owner）：进度播报 每 5 张 → 每 20 张，且两次至少间隔 10 秒。
  // 200 张图的页面原来会排 40+ 条播报，读屏队列要听很久；最终数量仍由批次总结报。
  const PROGRESS_EVERY = 20;
  const PROGRESS_MIN_GAP_MS = 10000;
  let lastProgressAt = 0;
  // 2026-11-15（owner）：「图片总数超过这个阈值，就只说『多张图片』，并且新增不再播报」。
  // 大页（信息流/商品列表）分批落定时，反复报「已为 12 张…」「已为 5 张…」纯属噪音；
  // 阈值取 20，与进度播报口径一致。小页仍报精确数字。
  const BULK_IMAGE_THRESHOLD = 20;
  let bulkAnnounced = false; // 大批量页的统计句是否已播（此后只做注入，不再播总结）
  let capCount = 0; // 验证码图计数（2026-09-29 用户要求 #6：验证码必须给提示，不能静默）
  let unknownCount = 0; // 「未知图片」兜底标注计数（2026-10-02 owner 铁律：垃圾文件名绝不出声）
  let altJudgeUsed = 0; // 本页决策模型 alt 判定已用次数（2026-09-30 需求：每页限量防刷）
  const altJudgeVerdicts = new Map(); // alt 文本 → 'junk' | 'keep'（同页同文本只判一次）
  let startAnnounced = false;
  let idleAnnounced = false;
  // 自上次总结以来是否处理过**非易变**的图片（见 settleIfIdle 的注释）
  let nonVolatileWork = false;

  // 会话 68：owner 选「结果到达即注入」—— 取消 2026-09-28 的批次静默约定
  //（等整批完成才写 alt 会把首张描述拖到整批结束，违反「零程序延迟」）。
  // 描述仍不主动逐张朗读（写 alt 不抢语音，NVDA 靠 G 导航读），只是**写入时机**改为回包即注入；
  // 回包先过「发起时 src 是否仍是当前 src」的时效性校验，变了就丢弃并披露。
  let batchBusy = false; // 「正在生成」已播报、完成播报未发
  let lastMoveAt = 0; // 最近一次真实鼠标移动时间（滚动不产生 pointermove）
  let lastPointer = { x: -1, y: -1 };

  // ---------- 易变图与覆盖度计数（会话 68）----------
  // 易变判定用「行为」而非类名：同一 <img> 的 src/srcset 被站点改过 ⇒ 视为易变。
  // 只统计**因 src 变更触发的重新描述**，静态图不计，避免误伤日限「不限制」的定案。
  let volatileDescribed = 0; // 本页易变图已描述的次数（上限 VOLATILE_LIMIT）
  let volatileSeen = new WeakSet(); // 已被判定为易变的 img
  let srcAtRequest = new WeakMap(); // el → 发起 AI 调用时的 src（结果时效性校验）
  // 2026-11-15：**真正的「在飞」标记**。srcAtRequest 只在发起时写入、从不清理，
  // 拿它当 inflight 会把「上一条早已完成的请求」误判成「新图已在请求中」⇒ 轮播
  // 转回同一张时既不重排也不查缓存，占位名一直挂着（owner 实测的「换图后仍念第一张」）。
  let inflightSrc = new WeakMap(); // el → 此刻仍在等待回包的 src
  let describedSrc = new WeakMap(); // el → 已注入描述对应的 src（src 变更时作废旧 alt）
  let altBefore = new WeakMap(); // el → 注入前的作者 alt（start 时重建）

  // 覆盖度诚实：凡因成本 / 技术原因没描述的都要数清理由，供披露句与页面问答查询。
  let seenTotal = 0; // 本页进入管线的、缺 alt 的候选图总数
  const skipped = {
    cap: 0,          // 达到每页易变图上限（第 11 张起）
    changedTooFast: 0, // 结果回包时 src 已变 ⇒ 丢弃
    cacheEvict: 0,   // 缓存 FIFO 淘汰（超长页）
    loadFailed: 0,   // 图片加载失败 / 无法取字节
    quota: 0,        // 公益额度用完 / 每日上限
    nonBitmap: 0,    // CSS background / 非位图等管线不认的图
  };
  let lastCoverageText = ''; // 最近一次披露句（页面问答 / 布局地图查询用）
  let aiInjected = 0; // 本轮由 AI 生成并成功注入的描述数（总结播报用）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 配置与额度 ----------

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  async function loadConfig() {
    // 会话 69：孤立上下文（扩展重载后旧标签）里 chrome.storage.local.get 抛
    // "Extension context invalidated."。管线 start() 被 applyAll 的 awaitStep 兜住，
    // 但别让它在模块内部留下未捕获拒绝；拿不到配置时按「AI 未启用」安静降级，
    // 本地装饰识别/图标词典照常可用，SW 自愈重注入后恢复完整能力。
    let stored = {};
    try {
      stored = await chrome.storage.local.get(['ws_ai_config', 'ws_image_config', 'ws_ai_usage', 'ws_ai_descriptions'])
        || {};
    } catch {
      stored = {};
    }
    const ai = stored.ws_ai_config || {};
    const img = stored.ws_image_config || {};

    // AI 可用 = 主开关（智能场景解析增强）开启 + 任一档配齐「接口 + 视觉模型」。
    // 密钥在 SW 侧解密使用，内容脚本只看配置布尔（缺密钥时调用报错 → failed 计数）
    // 2026-10-04 双档口径：primary 前置档可留空、default 默认档必填——读键统一走
    // WS_AI_SLOTS（含旧名 main/back 回退），改名遗漏曾在此静默禁用 AI（用例 28 回归）
    const visionReady = window.WS_AI_SLOTS?.visionReady?.(ai) === true;
    // v0.2 第 8 项：敏感站点（政务/医疗/金融，未在设置页放行）一律不发图片字节——
    // 本地能力（装饰识别、图标词典）不受影响，只是不产生任何对外调用
    const privacyOk = window.WS_AI_PRIVACY?.allowed?.() !== false;
    aiAvailable = window.WS_AI_SLOTS?.enabled?.(ai) === true && visionReady && privacyOk;
    // 老数据没有 limitEnabled ⇒ 按 dailyLimit>0 推断，保证已有用户行为不变（0 仍是不限）
    const rawLimit = Number(img.dailyLimit);
    const limitValid = Number.isFinite(rawLimit) && rawLimit >= 0;
    limitEnabled = img.limitEnabled === true
      || (img.limitEnabled == null && limitValid && rawLimit > 0);
    dailyLimit = limitValid ? Math.max(0, Math.round(rawLimit)) : 0;
    hoverReplay = !!img.hoverReplay; // 悬停重听（默认关；低视力用户在设置页开启）

    // 跨刷新描述缓存（按当前源取桶）
    const allDesc = stored.ws_ai_descriptions || {};
    describedCache = allDesc[ORIGIN] || {};

    const u = stored.ws_ai_usage;
    usage = u && u.date === today() ? { date: u.date, count: Number(u.count) || 0 } : { date: today(), count: 0 };
    if (!u || u.date !== usage.date) await saveUsage();
  }

  async function saveUsage() {
    try { await chrome.storage.local.set({ ws_ai_usage: usage }); } catch { /* 会话 69：孤立上下文静默降级 */ }
  }

  async function persistDescriptions() {
    // 每源 FIFO 上限，防存储膨胀
    const entries = Object.entries(describedCache);
    if (entries.length > CACHE_MAX_PER_ORIGIN) {
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      // 会话 68：FIFO 淘汰属于「因成本/技术没做的事」，计入覆盖度供披露与查询。
      skipped.cacheEvict += entries.length - CACHE_MAX_PER_ORIGIN;
      describedCache = Object.fromEntries(entries.slice(entries.length - CACHE_MAX_PER_ORIGIN));
    }
    // 会话 69：孤立上下文 / 配额耗尽时存储写入可能抛；缓存写失败只影响下次刷新复用，
    // 绝不该让当前这张图的注入链抛错。
    try {
      const all = (await chrome.storage.local.get('ws_ai_descriptions')).ws_ai_descriptions || {};
      all[ORIGIN] = describedCache;
      await chrome.storage.local.set({ ws_ai_descriptions: all });
    } catch { /* 静默降级：内存态仍有效 */ }
  }

  function quotaLeft() {
    if (!limitEnabled) return true;   // 用户明确「不设上限」
    return usage.count < dailyLimit;  // 上限 0 ⇒ 今天一次都不给
  }

  async function consumeQuota() {
    usage.count += 1;
    await saveUsage();
  }

  // ---------- 分类（BP 4.3） ----------

  function isCaptcha(el) {
    // 会话 69：异常 DOM（非 Element / detached / 自定义元素）不应让分类链抛错。
    if (!el || typeof el.getAttribute !== 'function') return false;
    // 2026-11-15（长描述把 404 坏图念成「验证码」）：**绝不拿我们自己写进去的 alt 当判据**。
    // 坏图失败时会写「AI描述：图片位于「…验证码：…」附近」这类周边推测（旁边恰好有验证码图），
    // 旧实现把它算进 haystack ⇒ 同一张坏图下一轮被判成验证码，长描述直接拒绝、不再描述。
    // 这是自反馈污染：识别依据必须只来自站点的结构性声明（src / class / id / name）与作者 alt。
    const alt = el.getAttribute('alt') || '';
    const ownText = el.hasAttribute('data-ws-ai') || el.hasAttribute('data-ws-pending')
      || /^AI描述：|^图片内容已更新/.test(alt);
    const hay = [
      el.getAttribute('src') || '',
      el.getAttribute('class') || '',
      el.getAttribute('id') || '',
      el.getAttribute('name') || '',
      ownText ? '' : alt,
    ].join(' ');
    return CAPTCHA_RE.test(hay);
  }

  // 是否位于交互上下文（按钮/链接）内
  function inInteractiveContext(el) {
    return !!el.closest(
      'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
        'label, summary, [onclick]'
    );
  }

  // alt 是否"缺失"：无 alt 属性 → 缺失；alt 为空 → 作者声明装饰性，不动；
  // alt 是文件名/URL → 视为缺失（BP 2.1）
  function altMissing(el) {
    if (el.tagName === 'SVG') {
      return !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby');
    }
    if (!el.hasAttribute('alt')) return true;
    const alt = (el.getAttribute('alt') || '').trim();
    if (!alt) return false;
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(alt)) return true;
    if (/^https?:\/\//i.test(alt)) return true;
    return false;
  }

  // ---------- 自带 alt 的质量判定（2026-09-30 用户需求） ----------
  //
  // 用户实测结论：有些网站自带 alt 且写得比 AI 好——**真描述绝不覆盖**（S3/S4
  // 主保护丝毫不变）。要抓的只有「比没有还糟」的假描述：image123 / 微信图片_2024 /
  // 乱码（鍥剧墖、锟斤拷）。两级判定：
  //   ① 本地高置信模式（免费、精确、可解释）——直接视同缺失走重生成；
  //   ② 疑似串（短、无汉字、无词间结构）→ 决策模型调用把关（每页限量、按文本去重），
  //     判垃圾才重生成；判有意义/失败/超限一律保留原 alt（宁保留勿覆盖）。
  const ALT_JUDGE_BUDGET = Infinity; // 2026-09-30 用户决策：调用限制全部移除（按文本去重仍在）

  // ASCII 垃圾词干：纯文件名/占位语义，不带任何图像内容信息（全串匹配，允许
  // 分隔符与后缀数字——image123 / IMG_20240101 / photo-2 都命中，dog 不命中）
  const JUNK_ASCII_RE =
    /^(?:img|image|images|photo|photos|picture|pics|pic|tupian|figure|fig|banner|bg|background|logo|icon|avatar|thumb|thumbnail|loading|spacer|placeholder|sample|test|tmp|temp|untitled|screenshot|mmexport|wechat|weixin|qq|ditu|blob|undefined|null|none|nan)[\s._\-–—]*(?:\d{1,8})?$/i;

  // 中文垃圾词干：同上（全串匹配；「地图2」这类真词不命中——stem 必须从头匹配）
  const JUNK_CJK_RE =
    /^(?:图片|图像|照片|相片|图|截图|屏幕截图|微信图片|微信截图|qq截图|qq图片|未命名|新建图像|新建位图图像|加载中|点击查看|查看大图|查看原图|示例图片|样图|占位图|商品图片|相关图片|大图|原图)[\s._\-]*(?:\d{1,20})?$/;

  // 乱码特征：GBK↔UTF-8 互转高频字（鍥剧墖/鐨勬槸 类）。刻意要求 ≥2 个命中——
  // 集合里的 浣/鏈/娣 等在繁体文本里是正常字，单个出现不判（宁保留勿覆盖）
  const MOJIBAKE_CHARS_RE = /[鍥鍚鏄鐢鐗娣鍟璁闂鈥銆銉鍦鏂鐩鍢鍊鐣鑾鍒浣鍖鐨鎶鏈鍝鍐鍕]/g;
  const ALT_HAS_CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;

  // 本地判定：这段 alt 是否「比没有还糟」的假描述（高置信才 true）
  function isGarbageAlt(alt) {
    const a = String(alt || '').trim();
    if (!a) return false;
    if (JUNK_ASCII_RE.test(a)) return true;
    if (JUNK_CJK_RE.test(a)) return true;
    if (/锟斤拷/.test(a)) return true; // GBK 循环编码的经典产物
    // 高频 GBK 乱码整串（UTF-8 中文被按 GBK 读出的固定产物，真文本绝不会出现）
    if (/鍥剧墖|涓婁紶|涓嬭浇|鏈嶅姟|鐐瑰嚮|鏌ョ湅|澶у浘|鍔犺浇|灞忓箷|鏂囦欢|棣栭〉|鐧诲綍|娉ㄥ唽|鏌ヨ|璇︽儏|鍥剧墖鏉ユ簮/.test(a)) return true;
    const moji = a.match(MOJIBAKE_CHARS_RE);
    if (moji && moji.length >= 2) return true;
    if (/�/.test(a)) return true; // 替换符
    if (/(?:%[0-9A-Fa-f]{2}){2,}/.test(a)) return true; // 双重百分号编码串
    if (/\\u[0-9a-fA-F]{4}/.test(a)) return true; // 未解码的 \uXXXX 转义
    if (/^(?:&#[0-9]+;){2,}/.test(a)) return true; // 数字实体串
    if (/^[\d\s.,_\-–—#()%·]+$/.test(a)) return true; // 纯数字/标点
    if (/^(.)\1{2,}$/u.test(a)) return true; // aaa / ～～～
    return false;
  }

  // 高置信乱码（会话 80 · owner 定）：交替字母+数字、无元音、≥3 个不同字母
  // → 本地直接判垃圾并重生成，**不再问决策模型**。例：q7x2m。
  // 刻意排除型号/格式（mp3、h264、rtx4090、X100）：
  //   要求「数字后面还跟字母」+ 全小写 + 4–8 位 + 无元音 + 至少 3 个不同辅音字母。
  function isHighConfidenceJunkAlt(alt) {
    const a = String(alt || '').trim();
    if (a.length < 4 || a.length > 8) return false;
    if (/[^a-z0-9]/.test(a)) return false; // 含标点/空格 → 交给决策模型
    if (!/[a-z]/.test(a) || !/\d/.test(a)) return false;
    if (!/\d[a-z]/.test(a)) return false; // 排除 x100 / rtx4090 这类尾随数字型号
    if (/[aeiou]/.test(a)) return false; // 无可读元音
    const letters = a.replace(/\d/g, '');
    return new Set(letters).size >= 3; // 排除 b2b / h1n1 / r2d2 这类只有 1–2 个字母的缩写
  }

  // 本地预筛：疑似串（短、无汉字、无词间结构）→ 交决策模型判。含汉字/日文/韩文/
  // 空格分隔的短语一律视为有意义（「狗」「Golden retriever」都是好 alt，绝不打扰）
  function isSuspectAlt(alt) {
    const a = String(alt || '').trim();
    if (!a || a.length > 12) return false;
    if (ALT_HAS_CJK_RE.test(a)) return false;
    if (/[\u3040-\u30FF\uAC00-\uD7AF]/.test(a)) return false;
    if (/\s/.test(a)) return false;
    return true;
  }

  // 决策模型调用：这段疑似 alt 是否该重生成？每页限量、按文本去重；
  // 任何失败/低置信/超限一律返回 false（保留原 alt——宁保留勿覆盖）
  async function judgeSuspectAlt(alt) {
    if (!aiAvailable) return false;
    const key = String(alt || '').trim();
    if (altJudgeVerdicts.has(key)) return altJudgeVerdicts.get(key) === 'junk';
    if (altJudgeUsed >= ALT_JUDGE_BUDGET) return false;
    altJudgeUsed++;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'WS_AI_DECIDE',
        state: { alt: window.WS_SANITIZE ? window.WS_SANITIZE.cleanText(key, 60) : key.slice(0, 60) },
        questions: {
          alt_junk: {
            type: 'noul',
            instructions: '这段网页图片的替代文本（alt）是无意义的垃圾内容吗（文件名、编号、乱码、无意义字符串）？',
            criteria: {
              true: '无意义——是文件名、编号、乱码或无意义字符串（如 image123、微信图片_2024、asdf），应当重新生成',
              false: '是有意义的描述，应当原样保留',
            },
          },
        },
      });
      if (!resp?.ok) throw new Error(resp?.error || '决策调用失败');
      const verdict = resp.answers?.alt_junk || {};
      // noul 返回形状兼容：数值概率（0-1）或布尔 + 可选 confidence——两种都正确判垃圾
      const p = typeof verdict.noul === 'number' ? verdict.noul : (verdict.noul === true ? 1 : 0);
      const junk = p >= 0.6;
      altJudgeVerdicts.set(key, junk ? 'junk' : 'keep');
      return junk;
    } catch {
      altJudgeVerdicts.set(key, 'keep'); // 判定失败 = 保留
      return false;
    }
  }

  function renderedSize(el) {
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width) || el.naturalWidth || el.width || 0;
    const h = Math.round(r.height) || el.naturalHeight || el.height || 0;
    return { w, h, max: Math.max(w, h) };
  }

  // 返回 'decorative' | 'icon' | 'content' | 'unknown'
  function classify(el) {
    const { max } = renderedSize(el);
    const interactive = inInteractiveContext(el);

    if (interactive) {
      return max > 0 && max <= ICON_MAX ? 'icon' : 'content';
    }
    if (max > 0 && max <= DECORATIVE_MAX) return 'decorative';
    if (max >= CONTENT_MIN) return 'content';
    return 'unknown';
  }

  // ---------- 注入（S5：AI 内容必须带前缀） ----------

  function inject(el, text) {
    // 新内容到位：清掉「待重新描述」标记（占位名随之被真实描述/作者值覆盖）
    try { el.removeAttribute('data-ws-pending'); } catch { /* 忽略 */ }
    if (el.tagName === 'SVG') {
      ctx.setAttr(el, 'role', 'img');
      ctx.setAttr(el, 'aria-label', text);
      return;
    }
    ctx.setAttr(el, 'alt', text);
  }

  // AI 描述注入额外打标（dwell 悬停重听的目标）。
  // 会话 68：记录「这个 alt 对应哪个 src」+ 注入前的作者 alt，供 src 变更时作废旧描述
  //（陈旧描述 = 错误信息，比沉默更糟；绝不碰作者原有 alt）。
  function injectAI(el, text, src) {
    rememberAlt(el);
    inject(el, text);
    if (el.tagName !== 'SVG') {
      ctx.setAttr(el, 'data-ws-ai', '1');
    }
    if (src) describedSrc.set(el, src);
  }

  // altBefore 已在上方「易变图与覆盖度计数」区声明为 let，start() 时重建。
  function altAttrOf(el) { return el.tagName === 'SVG' ? 'aria-label' : 'alt'; }
  function rememberAlt(el) {
    if (altBefore.has(el)) return;
    const attr = altAttrOf(el);
    altBefore.set(el, { had: el.hasAttribute(attr), value: el.getAttribute(attr) });
  }
  // 撤销本扩展注入的 alt：只在确实是我们写过、且 src 已变时调用。
  // ⚠️ 刻意**不走 ctx.setAttr**：注入时 setAttr 已把「作者原值」登记进 journal，
  // 关闭增强时 restoreAll 逆序恢复会还原作者原值；此处再登记只会污染 journal。
  // 运行期直接改 DOM，恢复作者原值/原缺失 ⇒ 不冒充描述，也不留陈旧内容。
  function restoreAuthorAlt(el) {
    const before = altBefore.get(el);
    if (!before) return;
    const attr = altAttrOf(el);
    if (before.had) {
      el.setAttribute(attr, before.value);
    } else if (el.tagName === 'SVG') {
      // SVG 没有作者名时，直接删掉 aria-label 也会让它从无障碍树里消失（G 同样跳过）
      el.setAttribute('aria-label', '图片内容已更新，正在重新生成描述');
    } else {
      // 2026-11-15（owner 实测「轮播图 G 不到」）：原先作者没写 alt 时直接 removeAttribute，
      // 于是换图后到新描述回包前（冷缓存可达数秒），<img> 无 alt ⇒ 在无障碍树里被当成装饰图，
      // NVDA 的 G 完全跳过它。改成留一个诚实的占位名：图仍可被 G 找到，也不冒充旧内容。
      el.setAttribute('alt', '图片内容已更新，正在重新生成描述');
    }
    // 占位名是我们写的，不是作者描述：打上「待重新描述」标记，processOne 才不会被
    // 上面的 S3/S4 保护挡住（否则非空 alt 会让它永远不再重生成）。走 setAttr 登记，
    // 关闭增强时随 journal 一起消失。
    try { ctx?.setAttr?.(el, 'data-ws-pending', ''); } catch { /* 忽略 */ }
    if (el.tagName !== 'SVG') el.removeAttribute('data-ws-ai');
    describedSrc.delete(el);
    altBefore.delete(el);
  }

  // 跨刷新缓存命中：**立即注入**（零生成、零等待）。会话 68 起所有描述都走这条「立即」路径。
  function collectFromCache(el, src) {
    const cached = describedCache[cacheKey(src)];
    if (!cached) return false;
    if (cached.cap) { rememberAlt(el); inject(el, cached.d); capCount++; doneCount++; describedSrc.set(el, src); return true; }
    if (cached.deco) { rememberAlt(el); inject(el, ''); doneCount++; describedSrc.set(el, src); return true; }
    if (!cached.d) return false;
    injectAI(el, `${AI_PREFIX}${cached.d}${cached.confident ? '' : UNCERTAIN_SUFFIX}`, src);
    doneCount++;
    describedCount++;
    return true;
  }

  // 会话 68：**结果到达即注入**（owner 选 (b)，取消批次静默）。
  // 唯一闸门 = 结果时效性：回包时若元素的 src 已不是发起调用时的 src，说明这张描述
  // 属于旧内容 ⇒ 丢弃、不注入、计入「变化太快未描述」并披露；仍可写入缓存（描述本身
  // 对旧 src 是正确的），避免下次变回来重新计费。全程零人为等待。
  //
  // 会话 70（真站实测 sina.com.cn）：**关闭增强时仍在飞行的 AI 回包绝不能再往页面写**。
  // 旧实现只靠 workerLoop 的 while (!stopped) —— 但那拦不住「已经在 await 里」的那一次：
  // 用户按关闭 → journal 已逆序还原 → 回包抵达 → commitInjection 又把 data-ws-ai 和
  // AI 写的 alt 写回去，且这次写入不会再被还原 ⇒ 页面留着「已关闭却在被改」的痕迹
  //（真站实测：关后 12 张 AI 标记剩 1 张，恰是那一张的回包赶在还原之后；162/sina 均复现）。
  // 修法：停止态直接丢弃注入（不影响缓存 —— 描述在请求回包时已写缓存，再次开启会立刻
  // 从缓存注入，不会多花一次模型调用，符合「零成本重复」口径）。
  function commitInjection(p) {
    if (!p || !p.el || typeof p.el.getAttribute !== 'function') return false; // 会话 69：畸形/已脱离文档
    if (stopped) return false; // 会话 70：已关闭 ⇒ 丢弃在飞回包（见上方注释）
    const cur = absoluteSrc(p.el);
    if (p.src && cur && cur !== p.src) {
      skipped.changedTooFast++;
      return false;
    }
    if (!p.el.isConnected) return false;
    if (p.cap) {
      rememberAlt(p.el); inject(p.el, p.text); capCount++; doneCount++;
      describedSrc.set(p.el, p.src); return true;
    }
    if (p.deco) {
      rememberAlt(p.el); inject(p.el, ''); doneCount++;
      describedSrc.set(p.el, p.src); return true;
    }
    injectAI(p.el, p.text, p.src);
    doneCount++;
    describedCount++;
    if (p.fromAI) aiInjected++;
    return true;
  }

  // 单图生成超时（60s，与 2026-09-27 的慢模型结论一致）；超时不拖死整批
  const DESCRIBE_TIMEOUT_MS = 60000;
  function describeWithTimeout(params) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('图片描述超时')), DESCRIBE_TIMEOUT_MS);
      ctx.describeImage(params).then(
        (r) => { clearTimeout(t); resolve(r); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  // 图片地址统一成绝对 URL：
  //   - 相对路径（src="img/a.jpg"）直接发给 SW 会被拒（它只认 http(s)），
  //     而 currentSrc 在图片尚未加载完成时为空，所以必须在这里解析；
  //   - 缓存键也要稳定：绝对地址在跨路径、跨刷新时都一致。
  // 懒图声明的真实地址（data-src / data-original / …）
  function lazyRealSrc(el) {
    for (const a of LAZY_ATTRS) {
      const v = el.getAttribute(a);
      if (v) return v;
    }
    return '';
  }

  // 元素是否真的把图渲染出来了（浏览器自己认得它）。用来把「渲染正常、只是模型看不了」
  // 的非位图源，与「真的坏图（404 / 解码失败）」区分开：前者本地维持原状，后者仍交真实
  // 路径去取字节 → 失败 → 由 applyFailureFallback 归因网站（UNREADABLE_IMAGE）。
  // 判据用 naturalWidth（图片解码成功才有 >0）。没有该属性的宿主（内联 SVG 等）按可渲染处理。
  function renderedOk(el) {
    if (!el || typeof el.naturalWidth !== 'number') return true;
    return el.complete === true && el.naturalWidth > 0;
  }

  // 非位图图源判定（2026-10-11 owner 拍板 · 外部扫站 v.qq.com 实锤）：
  //   · 非 http(s) 协议（data: / blob: …）→ SW 侧 fetchImage **第一行**即抛
  //     「不支持的图片地址协议」（vision.js 本地常量，不必真发一次往返去拿它）；
  //   · `.svg` 矢量文件 → 视觉模型不接受（浏览器渲染正常、模型看不了），取字节后
  //     createImageBitmap 解码即失败，注定走不到成功分支。
  // 两类都**不可能成功**。放这里本地判掉，省掉一次 SW 往返 + 一个并发槽位，
  // 也不再把注定失败的调用算进「管线AI失败」、不再打 console 失败日志。
  // ⚠️ 严格不改**注入文案**：本地与真实路径都走 applyFailureFallback 的同一分支
  //（维持原样 / 周边文本推测），verify-fixture 用例 21/24 钉死这一行为。
  // ⚠️ 仅在**元素确实渲染出来**时才本地判掉（renderedOk）：真坏图（如 404 的 .svg）
  // 要让真实路径去失败、以拿到「网站图片无法加载」的归因标注。
  function isNonBitmapSource(el, src) {
    const nonBitmap = !/^https?:/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);
    return nonBitmap && renderedOk(el);
  }

  function absoluteSrc(el) {
    // 会话 69：真实站点里 el 可能是 SVG / 自定义元素 / 已 detach 的节点；
    // currentSrc、getAttribute 在不同节点类型上行为不同，统一守护避免抛错。
    if (!el || typeof el.getAttribute !== 'function') return '';
    let raw;
    if (el && el.tagName === 'IMG' && isLazyPending(el)) {
      // 懒图：真实地址由站点写在 data-* 里（src 通常是占位小图）。既然要对齐
      // 「盲人不滚动也要读全图」，就不再等浏览器把真图换进 src——直接取 data-* 真地址，
      // 由 SW 侧 fetch 字节（跨域也没问题）。取不到再回退 currentSrc/src。
      raw = lazyRealSrc(el) || el.currentSrc || el.getAttribute('src') || '';
    } else {
      raw = el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src') || '';
    }
    if (!raw) return '';
    if (/^https?:/i.test(raw)) return raw;
    if (/^(data|blob):/i.test(raw)) return raw; // 取不到字节，走 BP 4.4 第 4 档降级
    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  }

  // ---------- 单张处理 ----------

  async function processOne(el) {
    if (!el.isConnected) return;
    if (el.closest('[aria-hidden="true"]') || el.closest('[data-ws-hidden]')) return;
    if (isCaptcha(el)) {
      // S7 修订（2026-09-29 用户反馈 #6）：验证码不能零提示——注入固定文案「验证码图片」
      //（绝不描述内容、绝不发送图片字节、不打 data-ws-ai 故 dwell 不重听），完成播报报数。
      // 2026-09-30：站 alt 缺失或本就是文件名/乱码 → 固定提示（「image123」比没有还糟）；
      // 站 alt 是真描述（往往带「请输入图中字符」等指引）→ 绝不覆盖（S3 不变）
      if (altMissing(el) || isGarbageAlt(el.getAttribute('alt')) || isHighConfidenceJunkAlt(el.getAttribute('alt'))) {
        // 零生成 → 立即注入，不给 NVDA 读原始文件名的空窗
        inject(el, '验证码图片');
        capCount++;
        doneCount++;
        nonVolatileWork = true; // 让「另有 N 张验证码图片已标记」只随首批总结播一次
      }
      return;
    }
    if (!altMissing(el) && !el.hasAttribute('data-ws-pending')) {
      // S3/S4 主保护不变：真描述绝不覆盖。2026-09-30 用户需求起唯一例外 =
      // 本地高置信垃圾（文件名/乱码，isGarbageAlt）与决策模型判定的无意义短串
      //（judgeSuspectAlt，每页限量、按文本去重、失败/低置信一律保留）——
      // 这些比没有还糟，视同缺失走重生成
      const existingAlt = (el.getAttribute('alt') || '').trim();
      // 会话 80 · owner：本地已高度确定是乱码（isHighConfidenceJunkAlt）时直接重生成，
      // 不再花一次决策模型调用去确认。
      const junk = isGarbageAlt(existingAlt) || isHighConfidenceJunkAlt(existingAlt);
      const suspect = !junk && isSuspectAlt(existingAlt);
      if (!junk && !(suspect && (await judgeSuspectAlt(existingAlt)))) return;
    }

    const kind = classify(el);

    // 1) 装饰性：设空 alt，让它从无障碍树里消失，不消耗 AI
    if (kind === 'decorative') {
      inject(el, '');
      doneCount++;
      return;
    }

    // 2) 功能性图标 + 内容图片：先查图标词典（词典命中绝不调 AI，避免幻觉误标功能）
    let dictName = null;
    if (kind === 'icon') {
      const dict = window.WS_ICON_DICTIONARY;
      dictName = dict ? dict.lookup(el) : null;
      if (dictName) {
        // 词典命中零生成 → 立即注入（同缓存命中理由）；不打 AI 标（词典名非 AI 产出）
        inject(el, dictName);
        doneCount++;
        describedCount++;
        return;
      }
    }

    const src = absoluteSrc(el);
    if (!src) return;
    seenTotal++;
    const isVolatile = volatileSeen.has(el);
    if (!isVolatile) nonVolatileWork = true; // 见 settleIfIdle：易变图重描述不播总结

    // 会话 68：每页「易变图」描述上限 N=10。只拦「同一元素 src 变更后的重新描述」，
    // 静态图完全不受限（owner 会话 64 定「图片日限不限制」，不得连带改动）。
    // 达上限即停止并**立即披露**，绝不把「筛选后的前 10 张」呈现为页面全部内容。
    if (isVolatile && volatileDescribed >= VOLATILE_LIMIT) {
      skipped.cap++;
      maybeAnnounceCoverage();
      return;
    }

    // 词典未命中：AI 未启用就保持原样（不注入噪音）
    if (!aiAvailable) return;
    if (!quotaLeft()) {
      limitExceeded = true;
      skipped.quota++;
      return;
    }
    // 含缓存命中一并计数：让「只描述了前 10 张」的口径是**描述数**而非 API 调用数。
    if (isVolatile) volatileDescribed++;

    // 跨刷新缓存命中：登记历史描述（零 AI 成本、零延迟生成）。
    // 缓存键剥掉 cache-buster 参数，但取图仍用原始 src（签名/防盗链不受影响）。
    if (describedCache[cacheKey(src)]) {
      collectFromCache(el, src);
      return;
    }

    // 非位图图源本地即判失败（见 isNonBitmapSource 说明）：不占队列、不计 failed、
    // 不打失败日志，但**注入结果与真实路径逐字一致**（维持原样 / 周边推测）。
    // 只在元素已渲染时短路；真坏图仍走真实路径拿「网站图片无法加载」归因。
    if (isNonBitmapSource(el, src)) {
      // 会话 68：模型看不了的图源属于「技术原因未描述」，计入覆盖度。
      // 注意 applyFailureFallback 可能给出周边文本推测（那算已描述），故只在
      // 最终没注入可听描述时才补计，避免把「有推测描述」误报成「没描述」。
      const before = describedCount;
      applyFailureFallback(el, kind, '不支持的图片地址协议');
      if (describedCount === before) skipped.nonBitmap++;
      maybeAnnounceCoverage();
      return;
    }

    // 2026-09-30 用户需求：图片是重要内容，不跳过任何一张（不分尺寸、不设单页上限）
    // ——顺序处理、逐张生成；配额与混合 fallback 控制总量与速度。
    // 会话 68：易变图不参与「每 5 张」进度播报（否则轮播切换会变成连续打断），
    // 也不触发「正在为 N 张生成」开场 —— 纯易变页 aiQueued=0，报「正在为 0 张」是谎言。
    if (!isVolatile) {
      aiQueued++;
      announceGenerating(); // 首个 AI 任务入队即报（实际播报等场景解析完，数量取届时已入队总数）
    }
    // 结果时效性校验的基准：**发起调用时**的 src。回包时若已变 ⇒ 结果为旧内容，作废。
    srcAtRequest.set(el, src);
    inflightSrc.set(el, src);

    let result;
    try {
      // 2026-09-29 用户需求 #8：看不出来是什么的图（unknown）走「分类+描述一体化」调用，
      // 分类规则是嵌入式局部系统提示词（嵌在 SW 侧 vision.js，不从页面传入），同成本不增费
      result = await describeWithTimeout({
        url: src,
        context: buildContext(el),
        kind: kind === 'unknown' ? 'classify' : 'photo',
      });
      if (!isVolatile) noteAiSettled(true);
    } catch (err) {
      if (!isVolatile) noteAiSettled(false);
      // 诊断留痕（2026-10-01）：失败曾是完全静默的，导致「生成失败」只能靠猜。
      // 失败原因写进 console（前缀 [WennSicht]，img-trace 的 console 采集可捕获），
      // 同时作为失败播报文案的判据（见 aiFailureMessage）。
      lastAiError = String(err?.message || err || '');
      console.warn('[WennSicht] 图片描述失败：', src, lastAiError);
      // BP 4.4 第 4 档：取不到字节（跨域 / 链接失效 / 协议不支持）→ 用周边文本做**推测**描述，
      // 并明确标注「AI推测，未直接查看图片」。图标不在此列——它有「功能图标，无法确定」的既有降级，
      // 用周边文字猜一个图标名反而更容易误导。
      failed++;
      skipped.loadFailed++;
      applyFailureFallback(el, kind, lastAiError);
      inflightSrc.delete(el);
      return;
    }
    inflightSrc.delete(el);

    // 结果时效性校验（零等待）：src 在回包前变过 ⇒ 旧描述绝不注入。
    if (srcAtRequest.get(el) !== src || absoluteSrc(el) !== src) {
      skipped.changedTooFast++;
      // 2026-11-15（owner：轮播「换图后仍念第一张的描述」）：
      // 结果对**发起时的 src** 是正确的，只是页面已经轮换走了。旧实现直接丢掉、
      // 连缓存都不写 ⇒ 4 秒一换的轮播上每次回包都晚于下一次换图，**永远**不命中，
      // 也永远没有一张新图能拿到描述。现在写进缓存：转回来那一刻零成本立即注入。
      await cacheStaleResult(src, result);
      maybeAnnounceCoverage();
      return;
    }

    await consumeQuota();
    describedUrls.add(src);

    // 分类器结果分流（2026-09-29 #6/#8）：验证码给固定提示不描述内容；装饰图置空 alt。
    // 会话 68：结果到达即注入（不再登记到 pendingInjections 等整批）。
    const key = cacheKey(src);
    if (result.type === 'captcha') {
      commitInjection({ el, src, text: '验证码图片', confident: true, fromAI: false, cap: true });
      describedCache[key] = { d: '验证码图片', cap: true, ts: Date.now() };
      await persistDescriptions();
      return;
    }
    if (result.type === 'decorative') {
      commitInjection({ el, src, text: '', confident: true, fromAI: false, deco: true });
      describedCache[key] = { d: '', deco: true, ts: Date.now() };
      await persistDescriptions();
      return;
    }

    // 模型输出也过一遍清洗：图片里的文字可能携带注入句式被模型复述；
    // 屏幕阅读器用户听到的必须是干净的描述（BP 4.6 纵深防御）
    let description = result.description;
    if (window.WS_SANITIZE) {
      description = window.WS_SANITIZE.cleanText(description, 120);
    }
    if (!description) {
      failed++;
      return;
    }

    // 图标与内容图的注入策略不同（BP 3.1.2：关键操作图标不能瞎猜）。
    // 会话 68：结果到达即注入（零人为等待）；commitInjection 内部再过一次时效性校验。
    let text;
    if (kind === 'icon') text = result.confident ? `${AI_PREFIX}${description}` : UNKNOWN_ICON;
    else if (kind === 'unknown') text = result.confident ? `${AI_PREFIX}${description}` : UNKNOWN_IMAGE;
    else text = `${AI_PREFIX}${description}` + (result.confident ? '' : UNCERTAIN_SUFFIX);
    commitInjection({ el, src, text, confident: !!result.confident, fromAI: true });

    // 跨刷新持久化：同一图片不再二次计费（注入与缓存写入都在回包这一刻完成）
    describedCache[key] = { d: description, confident: !!result.confident, ts: Date.now() };
    await persistDescriptions();
  }

  async function cacheStaleResult(src, result) {
    try {
      if (!src || !result) return;
      const key = cacheKey(src);
      if (result.type === 'decorative') {
        describedCache[key] = { d: '', deco: true, ts: Date.now() };
      } else if (result.type === 'captcha') {
        describedCache[key] = { d: '验证码图片', cap: true, ts: Date.now() };
      } else {
        let d = result.description;
        if (window.WS_SANITIZE) d = window.WS_SANITIZE.cleanText(d, 120);
        if (!d) return;
        describedCache[key] = { d, confident: !!result.confident, ts: Date.now() };
      }
      await persistDescriptions();
    } catch { /* 缓存写失败不影响主流程 */ }
  }

  // 取图片周边的短文本作为模型参考（BP 3.1.1「上下文增强」）。
  // 阶段 3.3：上下文来自页面，送模型前必须过提示注入清洗（BP 4.6）
  function buildContext(el) {
    // 会话 80：figure 里的 figcaption 是作者写给这张图的说明，优先取它（120 字）；
    // 没有图注再退回容器文本（80 字）。
    const cap = el.closest('figure')?.querySelector('figcaption');
    const capText = (cap?.textContent || '').replace(/\s+/g, ' ').trim();
    if (capText) {
      return window.WS_SANITIZE ? window.WS_SANITIZE.context(capText, 120) : capText.slice(0, 120);
    }
    const holder = el.closest('figure, li, article, section, div') || el.parentElement;
    if (!holder) return '';
    const text = (holder.textContent || '').replace(/\s+/g, ' ').trim();
    return window.WS_SANITIZE ? window.WS_SANITIZE.context(text, 80) : text.slice(0, 80);
  }

  // BP 4.4 第 4 档专用：图片**紧邻**的短文本。
  // 刻意不沿用到 body/main —— 否则会拿到整页文字，推测描述就变成噪音；
  // 三层内找不到 4~120 字的近邻容器就放弃（宁缺勿假，不给无语境的图编内容）。
  function localContext(el, maxLen) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html' || tag === 'main') break;
      const raw = (node.textContent || '').replace(/\s+/g, ' ').trim();
      // 去掉图片自身的 alt/title 内容，避免"用自己的话描述自己"
      const text = raw.length > 4 && raw.length <= 120 ? raw : '';
      if (!text) continue;
      return window.WS_SANITIZE ? window.WS_SANITIZE.context(text, maxLen) : text.slice(0, maxLen);
    }
    return '';
  }

  // 取不到字节时的降级：只陈述"这张图出现在什么语境里"，绝不猜测图里有什么
  function speculativeFromContext(el) {
    const ctxText = localContext(el, 60);
    if (!ctxText) return null;
    return `${AI_PREFIX}图片位于「${ctxText}」附近${SPECULATIVE_SUFFIX}`;
  }

  // 失败后的降级分支（纯本地判定，不触网）——2026-10-11 从 processOne 的 catch 里抽出，
  // 供两条路径**共用**：①真实 AI 调用失败（catch）；②已知必然失败的非位图图源
  //（processOne 里 enqueue 前的本地短路，见 isNonBitmapSource）。
  // 抽出的价值 = 「同一失败 ⇒ 同一结果」有了单一实现，两处不可能漂移。
  //   · 有周边文本 → 推测描述（最优路径，登记后批次统一注入）
  //   · 无线索且**图片侧故障** → 注入 UNREADABLE_IMAGE / UNKNOWN_ICON 的明确归因标注
  //   · 其余（密钥/接口类插件侧故障、非位图源）→ **维持原状**，由失败播报解释
  // ⚠️ 图片侧故障才允许注入「未知图片」：必须是**浏览器里也渲染不出来**的真坏图
  //（HTTP 失败 / 字节无法解码 / 服务器没回图片）。data:URI、SVG、超大图在浏览器里
  // 渲染正常、只是扩展无法处理——标「网站无法加载」是错误归因（verify-fixture
  // 用例 21/24 实测抓出），这类维持原状。
  function applyFailureFallback(el, kind, errText) {
    const imageSideFailure = /取图失败|无法解码|不是图片/.test(String(errText || ''));
    if (kind !== 'icon') {
      const guess = speculativeFromContext(el);
      if (guess) {
        // 最好情况：推测出一点线索（会话 68：结果到达即注入，不再等整批）
        commitInjection({ el, src: absoluteSrc(el), text: guess, confident: false, fromAI: true });
      } else if (imageSideFailure) {
        // owner 铁律（2026-10-02）：开了插件的网站绝不能让 "imagexxx" 这类文件名垃圾
        // 到用户耳朵里。推测也没有线索时，注入**明确归因网站**的未知标注——用户由此
        // 知道是网站图片坏了，不是插件没工作。仅限图片侧故障：密钥/接口类失败（插件
        // 侧问题）把图标成「网站无法加载」是撒谎，那种情况由失败播报解释、图片维持原状。
        // ⚠️ 立即注入、不等批次（2026-10-02 owner 实测 G 不到）：这是确定性标签不是
        // 生成内容，而 NVDA 的浏览缓冲可能在批次结束前就建好、纯属性更新吸收不稳定——
        // 晚一秒就可能被 G 导航永远漏掉。
        inject(el, UNREADABLE_IMAGE);
        unknownCount++;
        doneCount++;
      }
    } else if (imageSideFailure) {
      // 图标同样不给垃圾文件名留活口，但沿用图标自己的诚实降级文案（不给按钮名添噪音措辞）
      inject(el, UNKNOWN_ICON);
      unknownCount++;
      doneCount++;
    }
  }

  // ---------- 队列 ----------

  // 2026-09-30 用户需求：顺序优先从上到下——图片既然判定为重要内容就不跳着处理，
  // 视障用户也不会跳着看。文档序比较（前者在后者之前 → 排前）
  function docOrder(a, b) {
    if (a === b) return 0;
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  // 懒加载占位判定：有这些 data-* 属性的图，当前 src 可能是占位小图，
  // 直接处理会拿到占位图的描述；留给 IntersectionObserver/load 事件等真 src 换入
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-echo'];
  function isLazyPending(el) {
    for (const a of LAZY_ATTRS) if (el.hasAttribute(a)) return true;
    return false;
  }

  // 全量入队的统一判定：能立刻处理的直接入队（盲人用户不滚动也要能读到），
  // 只有真正等待加载的（懒加载占位 / 仍在下载）才交给 IntersectionObserver
  function enqueueIfReady(el) {
    if (el.tagName === 'SVG') {
      if (!el.hasAttribute('aria-label')) enqueue(el);
      return;
    }
    if (el.tagName === 'IMG') {
      if (isLazyPending(el) || !el.complete) {
        pendingLazy.add(el); // 交给 observer 尽早处理；兜底清扫保证视口外也不漏
        observer.observe(el);
        // 会话 80（真缺陷修复）：仍在下载的图**自己**再挂一次一次性 load/error。
        // 旧实现只靠 ① document 捕获监听（它是在 await loadConfig() 之后才注册的，
        // 首屏图在这段窗口里加载完就永久错过该事件）② 5 秒起的兜底清扫（后台标签
        // 定时器会被冻结）。实测后果：同一页三张图只处理到一部分，其余静默不生成，
        // 且没有任何日志。元素级 once 监听不依赖注册时机，也不依赖定时器。
        el.addEventListener('load', onResourceLoad, { once: true });
        el.addEventListener('error', onResourceLoad, { once: true });
        return;
      }
      enqueue(el); // 已加载（含加载失败：自然宽 0 → 走 BP 4.4 第 4 档推测描述）
      return;
    }
    enqueue(el); // input[type=image] 等
  }

  function enqueue(el) {
    pendingLazy.delete(el);
    if (stopped || !el.isConnected) return;
    if (seen.has(el) || processed.has(el)) return;
    seen.add(el);
    idleAnnounced = false; // 会话 68：有新任务 ⇒ 允许新批次再总结一次
    queue.push(el);
    queue.sort(docOrder);
    run();
  }

  // 兜底清扫：页面稳定后，把「已交给 observer 但从未入队」的懒图直接入队。
  // 视口外不再等于不处理（见文件头 LAZY_SWEEP_MS 说明）。
  function scheduleLazySweep() {
    for (const ms of LAZY_SWEEP_MS) {
      lazySweepTimers.push(
        setTimeout(() => {
          if (stopped) return;
          for (const el of [...pendingLazy]) {
            if (!el.isConnected) {
              pendingLazy.delete(el);
              continue;
            }
            enqueue(el);
          }
        }, ms)
      );
    }
  }

  // 2026-09-30 混合 fallback：并发工作池（10 路）。任务按文档序出队（shift），
  // 大部分耗时在 SW 侧网络调用（main 1 RPS + back 并行溢出），并发提升整体
  // 吞吐到 ≥ 2 张/秒；DOM 侧操作轻量，不会阻塞主线程影响屏幕阅读器
  async function run() {
    if (running || stopped) return;
    running = true;
    try {
      const workers = [];
      for (let i = 0; i < WORKER_COUNT; i++) workers.push(workerLoop());
      await Promise.all(workers);
    } finally {
      running = false;
      // 会话 68：队列一空立即总结 + 披露（事件驱动，取代定时轮询；无 setTimeout）。
      // ⚠️ 竞态护栏（会话 68 实跑 verify-hover-toggle 抓出）：在 workers 收尾、
      // running 仍为 true 的最后瞬间若有新图 enqueue，那次 enqueue() 调的 run()
      // 会因 `if (running) return` 直接退出 ⇒ 队列无人接手、announceSummary 永不执行、
      // batchBusy 永远 true（dwell 重听被永久挡住）。故收尾时若队列非空，
      // **同步再起一轮** worker（不引入任何定时器），空了才 settle。
      if (!stopped && !paused && queue.length) run();
      else settleIfIdle();
    }
  }

  async function workerLoop() {
    while (!stopped && queue.length) {
      if (paused) {
        await sleep(400);
        continue;
      }
      if (limitExceeded) {
        queue.length = 0;
        break;
      }
      const el = queue.shift();
      if (!el || processed.has(el)) continue;
      processed.add(el);
      try {
        await processOne(el);
      } catch (err) {
        // 单张失败不影响其余图片。会话 80：不再完全静默——单图异常曾让「一张图没被
        // 描述」只能靠猜（同一页其余图正常，日志里什么都没有）。只写 console，不播报。
        console.warn('[WennSicht] 图片处理异常：', el?.currentSrc || el?.getAttribute?.('src') || '', String(err?.message || err));
      }
    }
  }

  // ---------- 语音播报与批次统一注入（用户定义的最终模型，见文件头） ----------

  // 2026-10-31（owner）：设置页「播报增强做了什么」总开关（默认开，`content.js` 写入
  // `window.WS_VERBOSE_CHANGES`）。关掉后**不再报「正在为 N 张…／已为 N 张…」这类统计**，
  // 但**出错、图片无法加载、验证码**这些需要用户知道的句子照旧——噪音控制不能变成"坏了也不说"。
  const verboseChanges = () => window.WS_VERBOSE_CHANGES !== false;

  // 「正在为 N 张图片生成缺失的描述。」：AI 生成开始时立即播报（按 aiQueued 实数），
  // 等场景解析播报完再发，保证「总览 → 图片提示」的用户定义顺序。
  // 迟到检查 !batchBusy：批次极快全部落定（如整页取图 404）时总结已把 batchBusy
  // 置 false——此刻再播「正在生成」就是谎言（图都已失败/完成），跳过。
  function announceGenerating() {
    if (startAnnounced || batchBusy || !ctx) return;
    batchBusy = true;
    startAnnounced = true;
    if (!verboseChanges()) return; // 关掉统计播报：不播「正在为 N 张…」，但状态机照旧推进
    waitForScene().then(() => {
      if (stopped || !ctx || !batchBusy) return;
      // 大页只报「多张图片」：精确数字在分批落定时毫无意义，而且每次波动都要重播
      const bulk = seenTotal > BULK_IMAGE_THRESHOLD;
      ctx.announce(`正在为${bulk ? '多张' : ` ${aiQueued} 张`}图片生成缺失的描述。`, { boot: true });
    });
  }

  // 每 PROGRESS_EVERY 张生成完成播报一次进度（2026-09-30 需求；会话 80 改为 20 张 + 最短 10 秒）：
  // 「已为 N 张图片生成缺失的描述，剩余 t-N 张。」——统计口径 = AI 任务落定
  // （成功 + 失败都算落定，「剩余」= 未落定）；最后一批由批次总结播报，不重复报。
  function noteAiSettled(ok) {
    aiSettled++;
    if (ok) aiOk++;
    if (!batchBusy || !ctx || stopped) return;
    const remaining = aiQueued - aiSettled;
    if (aiSettled % PROGRESS_EVERY !== 0 || remaining <= 0 || !verboseChanges()) return;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_MIN_GAP_MS) return;
    lastProgressAt = now;
    ctx.announce(`已为 ${aiOk} 张图片生成缺失的描述，剩余 ${remaining} 张。`, { boot: true });
  }

  // 会话 68 · 覆盖度披露（新铁律「覆盖度诚实」）。
  // 与「统计句」彻底分开：统计句受 verboseChanges 剥离、且等 waitForScene；
  // 披露句**独立播报、永不受开关剥离、不等 waitForScene、不进 speakUntil 排队**
  //（content.js 的 announce 对 opts.coverage 放行），做到「一旦发生必须说」又不拖慢。
  // 只在情况真的发生时构造；文案全部来自 COVERAGE_TEXT 常量对象（改字不碰逻辑）。
  function buildCoverageText() {
    const any = skipped.cap + skipped.changedTooFast + skipped.cacheEvict +
      skipped.nonBitmap + skipped.quota + skipped.loadFailed;
    if (!any) return '';
    const parts = [];
    if (skipped.cap > 0) parts.push(COVERAGE_TEXT.cap(VOLATILE_LIMIT));
    if (skipped.changedTooFast > 0) parts.push(COVERAGE_TEXT.changedTooFast);
    if (skipped.cacheEvict > 0) parts.push(COVERAGE_TEXT.cacheEvict);
    if (skipped.nonBitmap > 0) parts.push(COVERAGE_TEXT.nonBitmap);
    // quota / loadFailed 的原因由既有播报负责（额度用完 / 无法加载归因），
    // 不重复念；但只要有任意跳过，末尾这句「不是全部内容」必须说。
    parts.push(COVERAGE_TEXT.tail);
    return parts.join('');
  }

  // 零等待去重：文本变了才再播一次（多类跳过汇齐时补完整），文本相同不重播。
  // 不引入 setTimeout / debounce —— 会话 67「除了 API 响应，程序本身不能拖慢速度」。
  function maybeAnnounceCoverage() {
    if (stopped || !ctx) return;
    const text = buildCoverageText();
    if (!text || text === lastCoverageText) return;
    lastCoverageText = text;
    ctx.announce(text, { coverage: true });
  }

  // 供页面问答 / 布局地图查询「这页哪些图没描述、为什么」（纯本地、零 AI）。
  function getCoverage() {
    return {
      seenTotal,
      described: describedCount,
      volatileDescribed,
      limit: VOLATILE_LIMIT,
      skipped: { ...skipped },
      text: buildCoverageText() || lastCoverageText,
    };
  }

  // 等待场景解析结束（最多 10 秒）：保证播报顺序 = 场景解析 → 生成提示。
  // 必须是单例 promise：「正在生成」与批次总结各自调 waitForScene() 时，两个独立的
  // 轮询 promise resolve 时机不同——批次极快全部落定的页面（如整页取图 404），
  // 总结的等待会先 resolve，「生成失败」就播在「正在为 N 张生成」之前（2026-10-01
  // v10 页实测踩到）。共用一个 promise 后，.then 注册顺序 = 播出顺序。
  let sceneWaitPromise = null;
  function waitForScene() {
    if (!sceneWaitPromise) {
      sceneWaitPromise = (async () => {
        for (let i = 0; i < 20; i++) {
          const s = window.WS_SCENE?.get?.();
          if (s) return;
          await sleep(500);
        }
      })();
    }
    return sceneWaitPromise;
  }

  // 批量完成：仅一句短提示（绝不播报描述内容）。
  // 有 AI 生成 →「已为 N 张图片生成缺失的描述。」（N = 实际注入的 AI/推测描述数）；
  // 全缓存/纯词典（aiQueued=0）→「图片描述已就绪（N 张）」；
  // 额度用完明说；全部失败的明说失败（静默曾让用户以为功能没生效）
  // v0.2：页面上有验证码时，若还存在「语音/音频验证码」入口就补一句提示。
  // S7 只禁止**识别验证码内容**；告诉用户"还有别的方式"完全在合规范围内，
  // 而这正是登录流程被卡住时用户最需要的一句话。零 AI、只读。
  const VOICE_CAPTCHA_RE = /(语音验证码|语音播报|音频验证码|听语音|听声音|语音提示|无障碍验证)/;
  function voiceCaptchaHint() {
    try {
      for (const el of document.querySelectorAll('a, button, [role="button"], span, label')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 20) continue;
        if (VOICE_CAPTCHA_RE.test(t)) return '本页提供语音验证码等替代方式。';
      }
    } catch {
      return '';
    }
    return '';
  }

  // 失败播报必须「说到点子上」（2026-10-01 owner 实测）：听到的
  // 「请检查大模型配置」其实是**金库尚未解锁**（密钥读不出来，与配置无关），
  // 把用户和开发者都指向了错误的排查方向。按最近一次失败原因分流。
  function aiFailureMessage() {
    if (/金库|密钥/.test(lastAiError)) {
      return '图片描述生成失败：未能读取 API 密钥，请在设置页确认密钥金库已解锁。';
    }
    // 公益中转配额（2026-10-07 会话 20）：中转 429 的错误体带「公益额度已用完」，
    // 必须先于「请检查大模型配置」判出——公益档用户根本没有配置可检查，
    // 把他们引向配置页是错误归因（金库竞态事故同款教训：文案必须指向真实原因）。
    if (/公益额度/.test(lastAiError)) {
      return '图片描述生成失败：今日公益额度已用完，可明天再试，或在设置页改用自己的大模型接口。';
    }
    if (/超时/.test(lastAiError)) return '图片描述生成失败：接口超时，可稍后刷新重试。';
    // 取不到图片字节（404 / 跨域 / 协议不支持）是**图片资源**问题，不是模型配置
    // 问题——归进「请检查大模型配置」会把排查方向带偏（2026-10-01 v10 页实测：
    // 两张 404 夹具图让整页播「请检查大模型配置」）。
    if (/取图失败|不支持的图片地址协议|HTTP \d{3}/.test(lastAiError)) {
      return '部分图片无法获取（链接失效或地址不支持），未生成描述。';
    }
    return '图片描述生成失败，请检查大模型配置。';
  }

  function announceSummary() {
    if (stopped || !ctx) return;
    // 会话 68：描述已在回包时注入，不再有「批次统一注入」这一步。
    // 总结前先把**覆盖度披露**独立发出去：它不等 waitForScene、不受 verboseChanges
    // 剥离、不因「统计类句子被静音」而消失（覆盖度诚实铁律）。
    maybeAnnounceCoverage();
    const injectedAi = aiInjected;
    batchBusy = false;
    // 2026-11-15（owner）：大页（候选图总数 > BULK_IMAGE_THRESHOLD）只播**第一句**统计，
    // 之后新增/分批落定一律不播——否则信息流、商品列表会把总结变成无限循环的噪音。
    // 覆盖度披露（maybeAnnounceCoverage）在上面已经独立发过，不受此限。
    const bulk = seenTotal > BULK_IMAGE_THRESHOLD;
    if (bulk && bulkAnnounced) return;
    const capSuffix = capCount > 0 ? `另有 ${capCount} 张验证码图片已标记。` + voiceCaptchaHint() : '';
    // 未知标注播报（2026-10-02 owner 铁律）：让用户知道有几张图是网站自己坏的
    const unknownSuffix = unknownCount > 0 ? `另有 ${unknownCount} 张图片无法加载，已标注为未知图片。` : '';
    let msg = '';
    if (limitExceeded) {
      msg = '今日图片描述额度已用完，图片描述已暂停。' + unknownSuffix + capSuffix;
    } else if (aiQueued > 0) {
      if (describedCount > 0) msg = (bulk ? '已为多张图片生成缺失的描述。' : `已为 ${injectedAi || describedCount} 张图片生成缺失的描述。`) + unknownSuffix + capSuffix;
      else if (unknownCount > 0) msg = `${unknownCount} 张图片无法加载，已标注为未知图片。` + capSuffix;
      else if (failed > 0) msg = aiFailureMessage() + capSuffix;
      else if (capCount > 0) msg = capSuffix;
    } else if (describedCount > 0) {
      msg = (bulk ? '图片描述已就绪（多张），浏览到图片时即可听到。' : `图片描述已就绪（${describedCount} 张），浏览到图片时即可听到。`) + unknownSuffix + capSuffix;
    } else if (unknownCount > 0) {
      msg = `${unknownCount} 张图片无法加载，已标注为未知图片。` + capSuffix;
    } else if (capCount > 0) {
      msg = capSuffix;
    }
    if (!msg) return;
    if (bulk) bulkAnnounced = true; // 大页：这一句说过就不再播统计
    // 2026-10-31：关掉「播报增强做了什么」后，只剥**统计类**句子；
    // 「N 张图片无法加载」「另有 1 张验证码图片」「图片描述生成失败…」必须留下。
    if (!verboseChanges()) {
      msg = msg
        .replace(/已为 \d+ 张图片生成缺失的描述。/g, '')
        .replace(/已为多张图片生成缺失的描述。/g, '')
        .replace(/图片描述已就绪（\d+ 张），浏览到图片时即可听到。/g, '')
        .replace(/图片描述已就绪（多张），浏览到图片时即可听到。/g, '')
        .trim();
      if (!msg) return; // 只剩统计 ⇒ 这一批什么都不说
    }
    // 与「正在生成」同样等场景解析播报完成后再报，保证用户定义的顺序（总览 → 图片）
    const emit = () => {
      if (!stopped && ctx) ctx.announce(msg, { boot: true });
    };
    if (aiAvailable) waitForScene().then(emit);
    else emit();
  }

  // ---------- 悬停 dwell：停留 1 秒才读，同一次悬停只读一次（2026-09-29 用户修订：3 秒改 1 秒） ----------

  let dwellTimer = null;
  let dwellEl = null; // 当前悬停的图
  let dwellAnnounced = false; // 本次悬停是否已播报过（防同一悬停内重复读）

  // 滚动误触修复（2026-09-28 用户实测）：页面滚动时鼠标没动，浏览器也会对
  // 光标下方新元素发 pointerover —— 图片滚到光标下就静默开始计时，5 秒后突然朗读。
  // 门控：pointerover 距最近一次真实 pointermove 超过 400ms 视为滚动带来，忽略。
  function isRealHover() {
    return performance.now() - lastMoveAt < 400;
  }
  function onPointerMove(e) {
    if (e.clientX !== lastPointer.x || e.clientY !== lastPointer.y) {
      lastPointer = { x: e.clientX, y: e.clientY };
      lastMoveAt = performance.now();
    }
  }
  function onDwellOver(e) {
    if (!hoverReplay) return; // 2026-09-30 用户决策：悬停重听默认关闭（全盲靠 G；低视力可在设置页开启）
    if (!isRealHover()) return; // 滚动带来的 pointerover：不启动计时
    const img = e.target && e.target.closest ? e.target.closest('img[data-ws-ai]') : null;
    if (!img) { cancelDwell(); return; }
    scheduleDwell(img);
  }
  function onDwellFocus(e) {
    const img = e.target && e.target.closest && e.target.closest('img[data-ws-ai]');
    if (img) scheduleDwell(img, true);
  }
  // 会话 68：移除 `if (batchBusy) return;` —— 那是 2026-09-28「生成期间不读任何图片」
  // 旧契约的残留。owner 已选「结果到达即注入」：描述一旦注入就可读，用户主动悬停/
  // 键盘聚焦想重听，不该被扩展内部的批次状态拒绝服务（悬停目标本就限定 img[data-ws-ai]，
  // 即已注入描述的图；尚未生成的图根本不会成为目标）。
  // viaFocus=true（键盘焦点进入）不受「同一次只读一次」限制：焦点导航本就合法重听
  function scheduleDwell(img, viaFocus) {
    cancelDwell();
    if (!viaFocus && img === dwellEl && dwellAnnounced) return; // 同一次悬停已读过，不再重复
    dwellEl = img;
    dwellAnnounced = false;
    dwellTimer = setTimeout(() => {
      dwellAnnounced = true;
      const alt = img.getAttribute('alt') || '';
      if (alt && ctx) ctx.announce(alt);
    }, 1000); // 2026-09-29 用户定义：停留 1 秒即读（3 秒→1 秒）
  }
  // 指针离开图片：重置「已读过」状态，下次进入可重听
  function onDwellOut() {
    cancelDwell();
    dwellEl = null;
    dwellAnnounced = false;
  }
  function startDwellWatcher() {
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    // 悬停（开关开启时）：真实鼠标停在 AI 描述图片上 1 秒 → 读描述；移开取消并重置
    document.addEventListener('pointerover', onDwellOver, true);
    document.addEventListener('pointerout', onDwellOut, true);
    // 键盘用户焦点落在图上（如 role=button 包裹的场景）也可重听
    document.addEventListener('focusin', onDwellFocus, true);
  }
  function cancelDwell() {
    if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
  }

  // ---------- 生命周期 ----------

  async function start(context) {
    if (!stopped) return; // 已在运行
    ctx = context;
    stopped = false;
    paused = false;
    limitExceeded = false;
    doneCount = 0;
    describedCount = 0;
    failed = 0;
    lastAiError = '';
    aiQueued = 0;
    aiSettled = 0;
    aiOk = 0;
    lastProgressAt = 0;
    unknownCount = 0;
    altJudgeUsed = 0;
    altJudgeVerdicts.clear();
    startAnnounced = false;
    idleAnnounced = false;
    nonVolatileWork = false;
    bulkAnnounced = false;
    batchBusy = false;
    lastMoveAt = 0;
    lastPointer = { x: -1, y: -1 };
    queue.length = 0;
    // 会话 68：重建易变/覆盖度状态（WeakMap/WeakSet 无 clear，靠换对象重置）
    volatileDescribed = 0;
    volatileSeen = new WeakSet();
    srcAtRequest = new WeakMap();
    inflightSrc = new WeakMap();
    describedSrc = new WeakMap();
    aiInjected = 0;
    seenTotal = 0;
    lastCoverageText = '';
    altBefore = new WeakMap();
    for (const k of Object.keys(skipped)) skipped[k] = 0;
    for (const t of lazySweepTimers) clearTimeout(t);
    lazySweepTimers = [];
    pendingLazy = new Set();

    await loadConfig();

    // 没有 AI 也照常运行 —— 装饰性识别与图标词典都是本地规则，不需要模型
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          // 仍在下载中的等 load 事件；已加载完成（含加载失败的破图）入队处理
          if (el.tagName === 'IMG' && !el.complete) continue;
          enqueue(el);
        }
      },
      { rootMargin: '200px 0px' }
    );

    // 页面加载后先让规则修复完成，再启动图片队列（BP 4.3：0–1 秒只做规则修复）。
    // 全量入队（不依赖视口）：屏幕阅读器用户在浏览模式下读的是整个文档、
    // 并不会"滚动"——折叠下方图片也必须处理，否则 NVDA 只能读文件名。
    for (const el of document.querySelectorAll('img, svg[role="img"], input[type="image"]')) {
      if (seen.has(el) || processed.has(el)) continue;
      enqueueIfReady(el);
    }
    // 视口外懒图兜底（盲人不滚动）：若干次落点后强制入队未处理者
    scheduleLazySweep();

    // 懒加载图片在 load 之后才可用，load/error 事件后补一次入队
    document.addEventListener('load', onResourceLoad, true);
    document.addEventListener('error', onResourceLoad, true);

    if (aiAvailable) startDwellWatcher();

    // 总览兕底（2026-09-28 用户实测偶发「开启后完全静默」）：scene.js 只在成功时播报，
    // 决策调用失败（网络/配置）时页面只剩 NVDA 标题一句。4 秒后若场景解析已确认失败
    // 则补一句开场，保证开启后必有反馈（与「关闭页面结构总览」后续决策解耦，文案保守）
    setTimeout(() => {
      if (stopped || !ctx) return;
      const s = window.WS_SCENE?.get?.();
      if (s && s.error) ctx.announce('已开启页面增强，正在整理页面结构。', { boot: true });
    }, 4000);

    // 批量完成播报：轮询队列空闲
    pollDone();
  }

  function onResourceLoad(e) {
    const el = e.target;
    if (!el || (el.tagName !== 'IMG' && el.tagName !== 'svg')) return;
    if (seen.has(el) || processed.has(el)) return;
    // 仍在下载中的跳过；下载完成（含失败）都入队——破图走 BP 4.4 第 4 档推测描述
    if (el.tagName === 'IMG' && !el.complete) return;
    enqueue(el);
  }

  // SPA 增量入口（spa-watcher 调用）：动态插入的图片纳入处理
  function observeNew(els) {
    if (stopped || !observer || !els || typeof els[Symbol.iterator] !== 'function') return;
    for (const el of els) {
      // 会话 69：SPA 增量可能送来已 detach / 非 Element / 模板内的节点。
      try {
        if (!el || !el.isConnected || typeof el.getAttribute !== 'function') continue;
        if (seen.has(el) || processed.has(el)) continue;
        enqueueIfReady(el);
      } catch { /* 单条异常不影响其余新增节点 */ }
    }
  }

  // 会话 68 · 「替换式轮播」标记入口（spa-watcher 在同一批 mutation 里看到
  // 同父容器既有 removedNodes(img) 又有 addedNodes(img) 时同步调用，零等待）。
  // 只打标记：后续走 processOne 时受 VOLATILE_LIMIT 约束并计入覆盖度。
  function markVolatile(els) {
    if (stopped || !els || typeof els[Symbol.iterator] !== 'function') return;
    for (const el of els) {
      // 会话 69：非 Element / 畸形节点直接跳过，不让 WeakSet.add 抛错。
      if (!el || typeof el !== 'object') continue;
      try { if (el.tagName === 'IMG') volatileSeen.add(el); } catch { /* 忽略单条 */ }
    }
  }

  // 会话 68 · 「同一 <img> 原地换 src」入口（由 spa-watcher 的窄 attribute observer 调用）。
  // 这是会话 66 认定的最严重问题：旧 alt 对应旧内容，留着就是**错误信息**（比沉默更糟）。
  // 零人为等待：src 一变立刻 ① 判为易变 ② 撤销本扩展注入的旧描述 ③ 清去重守卫重新入队。
  // 描述次数受 VOLATILE_LIMIT 约束；回包再过一次时效性校验，变了就作废并披露。
  function onSrcChanged(el) {
    if (stopped || !observer || !el || !el.isConnected || el.tagName !== 'IMG') return;
    if (typeof el.getAttribute !== 'function') return; // 会话 69：畸形节点
    const prev = describedSrc.get(el);
    const inflight = inflightSrc.get(el);
    const now = absoluteSrc(el);
    // 已注入过描述、或上一次调用还在飞行中（结果会被时效性校验作废）⇒ 需要重排。
    // 两者都说明「这个元素会换内容」，用行为判定，不靠类名 / 不靠时间窗口。
    if (!prev && !inflight) return;
    if (!now || (prev && prev === now)) return;
    // 2026-11-15（owner：轮播「换图后仍念第一张的描述」）：
    // 旧实现把「新 src 已在请求中（inflight === now）」也直接 return —— 但那一刻
    // **旧 alt 仍挂在这个元素上**，于是换图后读屏继续念上一张的描述（错误信息）。
    // 现在先无条件撤销旧描述（留占位名，G 仍找得到），再看要不要重复入队。
    if (prev) restoreAuthorAlt(el);
    if (inflight === now) return; // 新内容已在请求中：不重复计费
    volatileSeen.add(el);
    seen.delete(el);
    processed.delete(el);
    enqueueIfReady(el); // 立即重排，无 debounce / 无 setTimeout
  }

  // 会话 68 · 队列空即触发（事件驱动），删掉旧的 1500ms 首等 + 1s/5s 轮询等待。
  // owner：「除了 API 调用本身的响应，程序本身不能拖慢速度」。
  // 注意：总结播报仍会等 waitForScene()（那是场景解析的播报顺序约定，不是注入延迟）；
  // 但**覆盖度披露句**由 maybeAnnounceCoverage() 独立立即发出，绝不被它拖住。
  let donePollTimer = null;
  function settleIfIdle() {
    if (stopped || paused || running || queue.length || idleAnnounced) return;
    idleAnnounced = true;
    // 2026-11-15（实听实测：轮播页每 4 秒播一遍「已为 1 张图片生成缺失的描述。另有 1 张验证码…」）：
    // 只有**易变图重描述**的这一批不播总结。易变图的整批语义就是「同一张图又变了」，
    // 用户既没发起新操作、也没有新内容需要知道；播总结等于按轮播节奏反复打断。
    // 首批（含首屏所有图/验证码）非易变，正常播一次。
    if (!nonVolatileWork) return;
    nonVolatileWork = false;
    announceSummary();
  }
  function pollDone() {
    // 零延迟：队列此刻可能已空（全缓存/无 AI 页）⇒ 微任务里判定一次；
    // 其余情况由 run() 的 finally / enqueue() 主动触发。
    queueMicrotask(settleIfIdle);
  }

  function stop() {
    stopped = true;
    paused = false;
    queue.length = 0;
    batchBusy = false;
    cancelDwell();
    document.removeEventListener('load', onResourceLoad, true);
    document.removeEventListener('error', onResourceLoad, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerover', onDwellOver, true);
    document.removeEventListener('pointerout', onDwellOut, true);
    document.removeEventListener('focusin', onDwellFocus, true);
    dwellEl = null;
    dwellAnnounced = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (donePollTimer) {
      clearTimeout(donePollTimer);
      donePollTimer = null;
    }
    for (const t of lazySweepTimers) clearTimeout(t);
    lazySweepTimers = [];
    pendingLazy = new Set();
    doneCount = 0;
    describedCount = 0;
    failed = 0;
    lastAiError = '';
    unknownCount = 0;
    // 重建去重集合：让「关→开」能把整页图片重新处理一遍（否则永不重注入）
    seen = new WeakSet();
    processed = new WeakSet();
  }

  // 「暂停 AI 描述」快捷键（BP 4.3）：只暂停 AI 调用，词典与规则继续工作
  function togglePause() {
    if (stopped) return null;
    paused = !paused;
    ctx?.announce(paused ? '图片描述已暂停。' : '图片描述已继续。');
    return paused;
  }

  // UNREADABLE_IMAGE 一并导出：image-longdesc 定位兜底要排除「未知图片」floor 图
  //（它没有字节可取，长描述必然失败，不该被当成定位候选——2026-10-03 owner 实测）
  // 会话 68 新增：onSrcChanged（spa-watcher 窄 attribute 观察回调）、
  // getCoverage（页面问答 / 布局地图查询覆盖度）、VOLATILE_LIMIT / COVERAGE_TEXT（回归断言）。
  return {
    start, stop, togglePause, observeNew, onSrcChanged, markVolatile, getCoverage,
    isPaused: () => paused, isRunning: () => !stopped,
    isGarbageAlt, isSuspectAlt, isCaptcha, isAiAvailable: () => aiAvailable,
    UNREADABLE_IMAGE, VOLATILE_LIMIT, COVERAGE_TEXT,
    // 供 dev/verify-carousel.mjs 纯函数直调（零 AI、零网络，与 page-qa.buildBlocks 同惯例）
    cacheKey, buildCoverageText,
  };
})();
