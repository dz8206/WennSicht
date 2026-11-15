// v0.2 工作单元 10（原始 #16/#17/#18 合并）· 图片描述长短分层（用户口径，不可回退）：
//   **短描述是默认、长描述必须用户主动要** —— 页面加载只生成 ≤40 字短描述（image-pipeline），
//   用户对某张图想听更多时，把光标移到该图上按「长描述」快捷键，才发起**一次视觉模型调用**。
//
// 为什么长描述走视觉通道（WS_DESCRIBE_IMAGE kind:'long'）而不是文本模型扩写短描述：
//   口径要求「有文字就完整转录，再补必要视觉信息」——只有看到图才可能转录；
//   让文本模型扩写 40 字短描述只会幻觉编造。SW 侧 vision.js 为 long 配专用提示词
//   （禁编造 + 完整转录条款），长描述**不进跨刷新缓存**（每次请求都是用户主动手势，
//   缓存反而让"再听一遍"变成陈旧数据；调用频率受快捷键手势天然限流）。
//
// 触发链：快捷键 `image-longdesc`（无默认键，chrome://extensions/shortcuts 自行绑定）
//   → SW 路由 WS_LONGDESC_REQUEST → content.js → 本模块 requestFor()。
//
// 「当前所在的图」怎么定位（NVDA 虚拟光标位置读不到，与焦点位置记忆同一困境）：
//   ① 真实 DOM 焦点在图上（焦点重听场景 / 图在可聚焦容器里）→ 直接用；
//   ② **都没有 → 一律弹选图对话框**（2026-10-04 owner 五轮实测定案的最终形态）：
//      此前的「文档序步进 + 视口最靠上 + 滚动沿追踪 + 选区跟踪」四轮启发式全部移除——
//      · 步进制造与真实光标漂移的"影子光标"（错一次错一串）；
//      · 滚动沿追踪建立在未证实的 NVDA 最小滚动落点假设上，时效窗口又把无关阅读
//        滚动当证据（弹窗↔错图来回翻）；
//      · 选区跟踪赌 NVDA 会同步 DOM 选区——实测**时灵时不灵**（同一个键有时弹窗
//        有时直答，owner：「没有任何规律」），"零风险渐进增强"实际引入了非确定性。  //      根治 = 把视口内的图片列成**可访问的选择列表**（带名字的容器 + 候选按钮，
//      复用 feedback.js 模式），用户 Tab 选择回车确认；视口内只有一张时直接描述
//      （唯一候选不存在猜错空间）。**同一状态永远同一行为——确定性压倒一切。**
//
// 纯信息图后缀判定（口径：**长描述文本 + 决策模型**，决策模型只吃文本）：
//   ① 决策模型（WS_AI_DECIDE，noul）：描述文本是否说明这是纯信息图/图表 → ≥0.6 加后缀；
//   ② 决策模型不可用/失败 → 本地兜底特征（≥2 个唯一「数字+单位」数据点）；
//   失败不阻塞主流程——后缀只是提示「这张图数据多、细节以图内文字为准」。
//
// 护栏：隐私门控（ai-privacy）→ 主开关+视觉模型配置；上下文只带周边 120 字（过 WS_SANITIZE、
//   剥 URL，S10）；模型输出整体过清洗（BP 4.6）；只读不改页面（S6）；单请求串行、防重入
//   （busy 时明确播报，绝不静默——2026-10-03 owner 实测教训）；
//   播报走扩展唯一的 live region（ctx.announce），本模块不建第二个播报源。
window.WS_IMAGE_LONGDESC = (() => {
  const INFOGRAPHIC_SUFFIX = '（信息图，含具体数据，请以图片内文字为准）';

  let busy = false;
  let ctx = null; // content.js 经 attach(buildCtx()) 注入；announce 走扩展唯一的 live region
  const infographicVerdicts = new Map(); // 描述前 40 字 → boolean（同页去重，省决策模型调用）
  // 内容侧硬看门狗：SW 挂死时 busy 不能永久卡住（SW 自身 60s 超时正常先到，此为兜底）
  const LONGDESC_WATCHDOG_MS = 90000;

  const clean = (s, n = 200) =>
    (window.WS_SANITIZE
      ? window.WS_SANITIZE.cleanText(String(s || '').replace(/\s+/g, ' ').trim(), n)
      : String(s || '').replace(/\s+/g, ' ').trim().slice(0, n));

  function visible(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.hasAttribute('data-ws-hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[data-ws-ignore-obs], [role="status"]')) return false; // 本扩展的播报与注入物
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  // 图上可用的「短描述」底料：AI 短描述（data-ws-ai）或作者 alt（真描述）。
  // 垃圾（文件名/乱码）与疑似串（≤12 无汉字无词结构）都不可扩写——扩写"img123"只会幻觉；
  // 用户应先等管线重生成（isGarbageAlt/isSuspectAlt 同一套本地判定，与管线零分歧）。
  function readExisting(el) {
    const aiAlt = (el.getAttribute('alt') || '').trim();
    if (!aiAlt) return null;
    if (window.WS_IMAGE_PIPELINE?.isGarbageAlt?.(aiAlt)) return null;
    if (window.WS_IMAGE_PIPELINE?.isSuspectAlt?.(aiAlt)) return null;
    return { kind: el.getAttribute('data-ws-ai') === '1' ? 'ai' : 'author', text: aiAlt };
  }

  // 视口内至少露出 minShown 像素
  function inViewport(el, minShown = 8) {
    const r = el.getBoundingClientRect();
    const vh = innerHeight || 800;
    return Math.min(r.bottom, vh) - Math.max(r.top, 0) >= minShown;
  }

  // 「未知图片」floor 图没有字节可取，长描述必然失败——它不该成为任何**候选**
  //（2026-10-03 owner 实测：G 到验证码却被兜底选中的是 floor 图）。验证码保留：
  // 用户真停在验证码上时，下游的 S7 拒绝句才是正确回应。
  function isUnreadableFloor(el) {
    const floor = window.WS_IMAGE_PIPELINE?.UNREADABLE_IMAGE;
    return !!floor && (el.getAttribute('alt') || '') === floor;
  }

  // 视口内的可描述候选（文档序）：选图对话框的数据源。排除 floor 图；
  // 垃圾 alt / 无 alt 的图保留——用户选它们会得到「还没有可用的短描述」的诚实回应。
  // 验证码图**不进候选**（2026-10-04 owner 实测）：它不可描述，列出来只会诱导误选
  // → 播出 S7 拒绝句，听感即「乱」。S7 拒绝句仍保留给焦点路径（那是唯一能解释
  // 「这张为什么永远没有描述」的场合）。
  function isSpecialImage(el) {
    return isUnreadableFloor(el) || !!window.WS_IMAGE_PIPELINE?.isCaptcha?.(el);
  }
  function listViewportCandidates() {
    const out = [];
    for (const img of document.querySelectorAll('img')) {
      if (!visible(img) || !inViewport(img)) continue;
      if (isSpecialImage(img)) continue;
      out.push(img);
    }
    return out;
  }

  // ---------- 「为什么不能生成长描述」的统一归因（2026-10-31 owner 实测）----------
  // 缺陷：选图列表把没有 alt 的图一律叫「还没有可用短描述的图片」——用户滚到页面下方
  // （测试 17/18 那几张矢量图、内嵌图、404 图）按快捷键，看到的是一串同样的字：
  // 既不知道那是哪张，也不知道它**永远**不会有描述。owner 原话：「如果用户上下到了列表中
  // 不能生成长描述的图片（验证码/坏链接/坏图片），那么相对应情况说出来。」
  // 现在统一走这里：**列表里名字就说原因，选中之后说同一件事**，两处口径不许分叉。
  const REASON_LABEL = {
    captcha: '验证码图片，不提供描述',
    broken: '图片无法加载（链接失效），不能生成长描述',
    nonbitmap: '特殊格式图片（矢量图或内嵌图），不能生成长描述',
    noshort: '短描述还在生成中，暂时不能扩写',
  };
  const REASON_SUFFIX = {
    captcha: '不提供描述',
    broken: '无法加载',
    nonbitmap: '特殊格式读不了',
    noshort: '短描述还在生成中',
  };
  // 作者的短描述本身已经把原因说清时**不再重复**（否则出现「未知图片：网站图片无法加载，无法加载」
  // / 「演示：矢量图（…读不了），特殊格式读不了」这种叠字，2026-10-31 实测抓到）
  const REASON_SEEN = {
    captcha: /验证码/,
    broken: /无法加载|未知图片|链接失效|404/i,
    nonbitmap: /矢量|内嵌|读不了|不支持|特殊格式/,
    noshort: /没有短描述|还没生成|生成中/,
  };
  // 与 failWith('不支持的图片地址协议') 的最终播报逐字同源（测试 18 依赖这句）
  const REASON_SAY = {
    captcha: '这是验证码图片，不提供内容描述。若需要无障碍方式，请使用页面上提供的语音验证码等替代入口。',
    broken: '这张图片无法加载（链接失效或格式不支持），不能生成长描述。',
    nonbitmap: '这张图片取不到内容（链接失效或格式不支持），无法生成长描述。',
    noshort: '这张图片还没有可用的短描述，请稍等描述生成完成后再试。',
  };
  // 返回原因码；null = 现在就能扩写
  function blockReason(el) {
    if (!el) return 'broken';
    const P = window.WS_IMAGE_PIPELINE;
    if (P?.isCaptcha?.(el)) return 'captcha';
    if (isUnreadableFloor(el)) return 'broken'; // 「未知图片」floor：没有字节可取
    const raw = el.getAttribute('src') || '';
    if (!raw) return 'broken'; // 没有 src：根本没图可读
    if (/^(data|blob):/i.test(raw)) return 'nonbitmap'; // 内嵌图源，视觉模型读不了
    const src = absoluteSrc(el);
    if (!src) return 'broken'; // 相对路径且非 http(s)：取不到字节
    if (/\.svg(?:[?#]|$)/i.test(src)) return 'nonbitmap'; // 矢量图：本地即判，不白跑一次调用
    try {
      if (el.complete && el.naturalWidth === 0) return 'broken'; // 加载完了却没内容 = 真坏图
    } catch {
      /* 取不到尺寸就按可描述处理 */
    }
    return readExisting(el) ? null : 'noshort'; // 没有短描述底料：扩写只会编造
  }
  // 选图列表里的一项叫什么（**绝不再出现「还没有可用短描述的图片」**）
  function candidateLabel(el) {
    const why = blockReason(el);
    const existing = readExisting(el);
    if (!why) return existing ? existing.text : '图片';
    if (!existing) return REASON_LABEL[why];
    // 有短描述的（比如带 alt 的坏链图）：先说它是什么，再补为什么不能扩写——已经说清就不补
    return REASON_SEEN[why].test(existing.text) ? existing.text : `${existing.text}，${REASON_SUFFIX[why]}`;
  }
  window.__WS_LD_LABELS__ = () => [...document.querySelectorAll('img')].map((im) => ({
    src: (im.getAttribute('src') || '').slice(0, 24),
    why: blockReason(im),
    label: candidateLabel(im),
  }));

  // 定位「用户所在的图」——**唯一可靠证据 = DOM 焦点**（见文件头注释）：
  // 焦点在图上 → 直接用；否则 null（调用方一律弹选择对话框让用户挑）。
  // 2026-10-04 终版：选区跟踪层也删了——它时灵时不灵（NVDA 对选区同步不一致），
  // 是「同一张图一会儿弹窗一会儿直答」的最后来源。同一状态必须永远同一行为。
  function locateImage() {
    const focused = document.activeElement?.closest?.('img');
    if (focused && visible(focused)) return focused;
    return null;
  }

  // ---------- 选图对话框（无证据时的确定路径，复用 feedback.js 的对话框模式） ----------
  let pickerRoot = null;
  let pickerSink = null; // 焦点落点（见 closePicker 注释）

  // 关闭对话框时的**确定式焦点交接**（2026-10-10 缺陷修复 + 2026-10-11 顺序修复）：
  //   旧实现直接 remove()——被聚焦的是对话框里的按钮，节点一销毁焦点就掉回 body；
  //   NVDA 把「聚焦对象被销毁」当成页面变化，会**重读文档 + 当前行**。owner 实测：
  //   确认选图后、长描述播出之前，页面里的图片又被念了一遍（含与本次请求无关的那张）。
  //   修复 = 永远不留悬空焦点：交给扩展自有的隐藏落点（1px、data-ws-ignore-obs），
  //   由它承载该路径该说的一句提示（焦点事件即时播报；失焦即销毁，不留页面残渣）。
  //   **刻意不还原「打开前焦点」**（feedback.js 的归还模式在此不适用）：选图对话框
  //   没有触发元素——它由快捷键打开，打开前的 DOM 焦点只是偶然状态（本页实测常是
  //   页面加载锚定的 H1）。把它还回去 = 又念一遍与本次请求无关的页面内容，正是本次
  //   要修的缺陷；同一状态永远同一行为（确定性压倒一切）。
  //   焦点不在对话框里被关掉（鼠标等边缘）→ 回落 live region，保证每句话恰好说一次。
  //
  //   ⚠️ **顺序也是必要条件**（2026-10-11 CDP 主世界时间线取证）：旧序「先 remove → 再 focus 落点」里，被聚焦的候选按钮**带着焦点被
  //   移除**，Chrome 只能把焦点退回文档对象（body）并为此派发一次 a11y 焦点事件；读屏
  //   收到「焦点落到文档」→ 报文档标题 + 当前行（与本次请求无关的图片描述），于是交接
  //   落点那句「已选择这张图片。」永远排在冗余之后——**补播一句救不了被销毁的焦点**。
  //   新序「先 focus 落点（此时对话框仍在 DOM 里，没有任何焦点销毁）→ 再移除节点」
  //   让 Chrome 全程无需退回文档。verify-v10 用「remove 被调用时焦点是否还在被移除子树
  //   里」把顺序钉死（顺序相关断言，反序必失败）。
  //
  //   ⚠️⚠️ **真因是容器角色 `role="dialog"`，不是移除时机**（2026-10-11 第三轮，
  //   脚本化取证 NVDA 实际播出的语音 —— dev/probe-speech-seq.mjs 直接读 NVDA 朗读
  //   查看器；dev/nvda-speech.ps1 + dev/speech-watch.mjs 是这套「机器耳朵」的基础设施）：
  //   owner 听到的是「在『正在生成…』与『已选择这张图片。』之间插进一段页面》，
  //   脚本复现的是同一件事：确认后读屏额外念出页面 H1（手测则是「文档 + 标题 + 图片行」
  //   —— 念哪一行取决于读屏光标当时停在哪里）。逐项消融（每次只改一处，4 轮一轮地测）：
  //     · 不动对话框、只交接焦点 → 仍复现  ⇒ 不是「对话框消失」引起的；
  //     · 交接前才去掉 role/aria-modal、延后移除、落点换 role=status/button、
  //       落点预建、落点改用 left:-9999px、先落框内再移出 → **全部仍复现 3~4/4**；
  //     · **容器不用 role="dialog"（用 role="group"）→ 4 轮全净**（只剩本流程自己的
  //       两句话）—— 实测 3/4 且那 1 轮是本流程按钮句的误判，与扩展页 4/4 复现形成对照。
  //   结论：焦点从 `role="dialog"` 子树里移出去，读屏（NVDA）会重定位并念一句页面内容。
  //   所以容器改用 **role="group" + aria-labelledby**：仍然有可访问名字（读屏报
  //   「要听哪张图片的长描述」），但不再触发对话框作用域的重定位。代价如实记下：
  //   读屏不再报「对话框」这个词，模态约束改由本模块自己的焦点陷阱 + Tab 环绕保证。
  //
  //   曾试过「先隐藏、700ms 后再移除节点」，想靠时间差把两批无障碍事件分开；改角色后
  //   它不再需要，而且会留下 700ms 的隐藏残节点（「弹窗是否已关」的判定要持续看到它），
  //   所以回到**立即移除**：交接已完成、此刻没人被聚焦，移除是静默的。
  function teardownPicker() {
    if (!pickerRoot) return;
    pickerRoot.remove();
    pickerRoot = null;
  }
  function dropSink() {
    if (!pickerSink) return;
    const s = pickerSink;
    pickerSink = null;
    try {
      s.remove();
    } catch {
      /* 已断开 */
    }
  }
  function closePicker(handoffText) {
    if (!pickerRoot) return;
    const hadFocusInside = pickerRoot.contains(document.activeElement);
    // ① 先把焦点交接给落点（对话框还在 DOM 里 → 焦点交接不销毁任何东西）
    if (hadFocusInside && handoffText && document.body) {
      const sink = ensurePickerSink();
      sink.textContent = handoffText;
      sink.focus({ preventScroll: true });
    }
    // ② 再移除对话框（此刻没人被聚焦，移除是静默的）
    teardownPicker();
    // 焦点不在对话框里（鼠标等边缘路径）：没人被销毁、不会触发重读；
    // 提示仍要有出处（恰好一次），走扩展唯一的 live region。
    if (!hadFocusInside && handoffText) announceLine(handoffText);
  }
  function ensurePickerSink() {
    if (pickerSink && pickerSink.isConnected) return pickerSink;
    pickerSink = document.createElement('div');
    pickerSink.id = 'ws-ldpick-echo';
    pickerSink.setAttribute('data-ws-ignore-obs', '');
    pickerSink.setAttribute('tabindex', '-1');
    pickerSink.style.cssText =
      'position:absolute;width:1px;height:1px;margin:-1px;border:0;padding:0;' +
      'overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    pickerSink.addEventListener('blur', dropSink, { once: true });
    document.body.appendChild(pickerSink);
    return pickerSink;
  }
  function openPicker(candidates) {
    if (pickerRoot || !document.body) return;
    pickerRoot = document.createElement('div');
    pickerRoot.setAttribute('data-ws-ignore-obs', '');
    // 自管焦点契约标记（content.js 的 site-modal 看护据此绕开本对话框）：
    // 看护的焦点陷阱在关闭路径上会把刚交接出去的焦点立刻拉回对话框内的按钮
    //（2026-10-11 取证），并在弹窗消失时把焦点还原到「打开前的页面元素」→ 又重读文档。
    // 本对话框自己保证：打开时初始焦点、Tab 环绕、关闭时交接，不依赖看护。
    pickerRoot.setAttribute('data-ws-modal-self', '');
    pickerRoot.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.4);font-family:system-ui,sans-serif;';
    const box = document.createElement('div');
    // 容器角色：**刻意不用 role="dialog"**（本轮机器耳朵实测出的修复，见文件头注释）：
    //   焦点从 role="dialog" 子树移到落点那一刻，NVDA 会重定位并额外念一句页面内容
    //   （扩展页 4/4 复现；换成 group 后 4 轮全净，只剩本流程自己的两句话）。
    //   读屏仍能报出本容器的名字（aria-labelledby 指向标题），只是不再有「对话框」这个词；
    //   模态约束由本模块自带的初始焦点 + Tab 环绕 + 快捷键开关语义保证（下方 keydown）。
    //   aria-modal 不配在非对话框角色上（会被忽略），故一并去掉。
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', 'ws-ldpick-title');
    box.style.cssText =
      'background:#fff;color:#111;max-width:34em;width:92%;padding:16px 18px;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.35);line-height:1.6;';
    pickerRoot.appendChild(box);
    const h = document.createElement('h2');
    h.id = 'ws-ldpick-title';
    h.textContent = '要听哪张图片的长描述';
    h.style.cssText = 'margin:0 0 6px;font-size:18px;';
    box.appendChild(h);
    const hint = document.createElement('p');
    // 被排除的特殊图（验证码 / 已标注无法加载）也要点名——否则用户「停在验证码上按键」时
    // 会对着一张缺了它的列表发懵（2026-10-04 owner 实测「乱」的另一半）。
    const viewportImgs = [...document.querySelectorAll('img')].filter((im) => visible(im) && inViewport(im));
    const excluded = viewportImgs.length - candidates.length;
    hint.textContent = `本屏内有 ${candidates.length} 张图片可选` +
      (excluded > 0 ? `（另有 ${excluded} 张不列出：验证码或已标注无法加载）` : '') +
      '。其中不能生成长描述的，名字后面直接写原因。用 Tab 或 Shift+Tab 选择，回车确认，Esc 取消。' +
      '默认停在「取消」上——确认前先 Tab 到想要的图片。';
    hint.style.cssText = 'margin:0 0 10px;font-size:14px;color:#444;';
    box.appendChild(hint);
    // 「取消」放**首位**并作为初始焦点（2026-10-04 owner 实测「乱」的主因）：
    // 旧版初始焦点落在第一个候选上——页面顶部第一个可见图常是 corrupt/验证码，
    // 用户按键后习惯性补一个回车确认 → 等于误选列表第一项 → 直接播出「未知图片」
    // 流程或验证码拒绝句，听感即「没弹窗就播了」。默认焦点 = 无害动作：误触回车
    // 只是关掉对话框，再按一次快捷键就回来；modal 看护的「焦点入弹窗首元素」与本
    // 初始焦点一致，不会打架。
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.style.cssText =
      'display:block;width:100%;text-align:left;margin:0 0 8px;padding:10px 12px;font:inherit;' +
      'border:1px solid #bbb;border-radius:6px;background:#f5f5f5;cursor:pointer;';
    cancel.addEventListener('click', () => closePicker('选图列表已关闭。'));
    box.appendChild(cancel);
    candidates.forEach((img, i) => {
      // 名字 = 短描述（有的话）否则**原因**；不再用「还没有可用短描述的图片」当占位（2026-10-31）
      const label = `${i + 1}、${candidateLabel(img)}`;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText =
        'display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px;font:inherit;' +
        'border:1px solid #99c;border-radius:6px;background:#eef;cursor:pointer;';
      b.addEventListener('click', () => {
        closePicker('已选择这张图片。');
        describe(img);
      });
      box.appendChild(b);
    });
    pickerRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker('选图列表已关闭。');
        return;
      }
      // Tab 环绕：本对话框已从 site-modal 看护里摘出（data-ws-modal-self），
      // 「焦点绝不跑到背景内容」由自己保住——与 page-qa.js 的对话框同一套做法（S6：只动焦点）。
      if (e.key !== 'Tab') return;
      const list = [...box.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0);
      if (!list.length) return;
      const idx = list.indexOf(document.activeElement);
      if (idx === -1) {
        e.preventDefault();
        (e.shiftKey ? list[list.length - 1] : list[0]).focus({ preventScroll: true });
      } else if (!e.shiftKey && idx === list.length - 1) {
        e.preventDefault();
        list[0].focus({ preventScroll: true });
      } else if (e.shiftKey && idx === 0) {
        e.preventDefault();
        list[list.length - 1].focus({ preventScroll: true });
      }
    });
    document.body.appendChild(pickerRoot);
    // 初始焦点 = 首个按钮 = 「取消」（无害动作，见上方注释；modal 看护兜底送焦点时
    // firstFocusableIn 也是它，两处一致）
    const first = box.querySelector('button');
    if (first) first.focus();
    // 2026-11-15（owner：「长描述无法触发，一直说选图列表已关闭」）：
    // 打开必须有一句**明确说出口**的确认。旧实现只靠焦点进按钮（读屏只念「取消 按钮」），
    // 页面自己的焦点陷阱/重渲染一旦把焦点抢走，用户就完全听不到「打开了」，
    // 再按一次便得到「已关闭」——听感就是快捷键彻底失效。这里补一句来源单一的确认。
    announceLine(`选图列表已打开：本屏有 ${candidates.length} 张图片。默认停在「取消」，按 Tab 选择后回车确认。`);
  }

  // 周边语境（S10：不含 URL——文本节点里偶有裸链接，一律剥掉；BP 4.6：进提示词前过清洗）
  function aroundText(el, maxLen) {
    const holder = el.closest('figure, li, article, section, div') || el.parentElement;
    if (!holder) return '';
    const raw = (holder.textContent || '').replace(/\s+/g, ' ').trim();
    const alt = el.getAttribute('alt') || '';
    const text = (alt ? raw.split(alt).join(' ') : raw).replace(/https?:\/\/\S+/gi, '');
    return clean(text, maxLen);
  }

  // 相对路径 → 绝对 URL（SW 只认 http(s)；与 image-pipeline.absoluteSrc 同规则）
  function absoluteSrc(el) {
    try {
      const raw = el.getAttribute('src') || '';
      if (!raw) return '';
      const u = new URL(raw, location.href);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch {
      return '';
    }
  }

  // ---------- 纯信息图判定 ----------

  // 本地兜底特征（纯函数、零成本）：文本含 ≥2 个唯一「数字+单位/%」数据点
  const NUM_POINT_RE = /(?:\d+(?:\.\d+)?\s*(?:%|％|万|亿|千|百|元|美元|人|次|吨|公里|kg|km|mm|cm|px|只|件|台|辆|度))/g;
  function isInfographicText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (/验证码|captcha/i.test(t)) return false; // 验证码图绝不进长描述链
    const nums = t.match(NUM_POINT_RE) || [];
    return new Set(nums).size >= 2;
  }

  // 决策模型判定（口径主路径，只吃长描述文本）：≥0.6 判纯信息图；任何失败 → 返回 null（交本地兜底）
  async function judgeInfographic(text) {
    const key = clean(text, 40);
    if (infographicVerdicts.has(key)) return infographicVerdicts.get(key);
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'WS_AI_DECIDE',
        state: { desc: key },
        questions: {
          infographic: {
            type: 'noul',
            instructions: '这段网页图片的描述文本，说明图片是「纯信息图/图表/数据图」吗？纯信息图指没有摄影画面的统计图、流程图、数据海报；照片里附带数据不算。',
            criteria: {
              true: '是纯信息图/图表/数据图（无摄影画面），提示用户细节以图内文字为准有价值',
              false: '不是——是照片、插画、截图等画面类图片',
            },
          },
        },
      });
      if (!resp?.ok) throw new Error(resp?.error || '决策调用失败');
      const verdict = resp.answers?.infographic || {};
      const p = typeof verdict.noul === 'number' ? verdict.noul : verdict.noul === true ? 1 : 0;
      const out = p >= 0.6;
      infographicVerdicts.set(key, out);
      return out;
    } catch {
      return null; // 失败交本地兜底，不缓存（下次决策模型恢复后可再判）
    }
  }

  // ---------- 主流程 ----------

  // 长描述请求入口（快捷键消息）。异步执行、立即 accepted；结果走播报。
  async function requestFor(el) {
    if (window.top !== window) return; // 只在顶层文档响应（快捷键消息会广播到所有框架）
    // 弹窗已开时再按 = 关闭（开关语义）。此前这里是静默返回——对话框还开着、按键
    // 却毫无回应，用户听感即「快捷键死了」（2026-10-04 owner：很多时候一到后面
    // 快捷键就不反应）。开关双向都有播报，永远有回应。
    if (pickerRoot && pickerRoot.isConnected) {
      // 开关语义：关闭并播报（提示由 closePicker 的焦点交接承载，见其注释）
      closePicker('选图列表已关闭。再按一次长描述快捷键可重新打开。');
      return;
    }
    // 2026-11-15（owner：「一直说选图列表已关闭，长描述无法触发」）：
    // 旧实现只看变量不看 DOM —— 对话框被页面重渲染摘掉后，pickerRoot 仍非空，
    // 于是**每次**按键都走「关闭」分支，永远打不开。残留引用一律视为已关闭。
    pickerRoot = null;
    if (busy) {
      announceLine('上一张图片的长描述还在生成中，请稍作等待。');
      return;
    }
    if (!el) el = locateImage();
    if (!el) {
      // 无证据路径（2026-10-03 根治）：绝不猜。视口内只有一张 → 直接描述（唯一候选
      // 不存在猜错空间）；多张 → 弹出选图对话框让用户挑（Tab 选择、回车确认）。
      const candidates = listViewportCandidates();
      if (!candidates.length) {
        // 两种「没有候选」分开说（2026-10-04 owner：「有时候触发有时候不触发」——
        // 旧文案把「本屏根本没有图」也说成「都不能生成」，位置不同话术不变，听感即随机）。
        const visibleImgs = [...document.querySelectorAll('img')].filter((im) => visible(im) && inViewport(im));
        if (visibleImgs.length) {
          const caps = visibleImgs.filter((im) => window.WS_IMAGE_PIPELINE?.isCaptcha?.(im)).length;
          const floors = visibleImgs.length - caps; // 候选只排除这两类，其余可见图即无法加载
          const detail = caps && floors ? `（${caps} 张验证码图片、${floors} 张无法加载）` : caps ? `（${caps} 张验证码图片）` : '（都是无法加载的图片）';
          announceLine(`本屏可见的 ${visibleImgs.length} 张图片都无法生成更长的描述${detail}。请把光标移到想听的图片上再按一次。`);
        } else {
          announceLine('本屏没有图片。请先把光标移到想听的图片上，再按长描述快捷键。');
        }
        return;
      }
      if (candidates.length === 1) {
        return describe(candidates[0]);
      }
      try {
        openPicker(candidates);
      } catch (err) {
        // 打开中途抛错（畸形节点 / 页面在构建期间清空 body …）：不能把半成品
        // pickerRoot 留在变量里，否则下一次按键会被当成「已打开」而只播关闭。
        pickerRoot = null;
        announceLine('选图列表打开失败，请刷新页面后再按一次长描述快捷键。');
        console.warn('[WennSicht] 长描述选图列表打开失败：', String(err?.message || err));
      }
      return;
    }
    return describe(el);
  }

  // 实际发起生成（目标图已确定——来自证据定位、对话框选择或单候选直答）。
  async function describe(el) {
    if (busy) {
      announceLine('上一张图片的长描述还在生成中，请稍作等待。');
      return;
    }
    // 2026-10-31（owner 实测）：**先说清「这张为什么不行」，且与选图列表里的名字同一口径**。
    // 这一处同时收掉了旧的三段分散判断：
    //   · 没有短描述 → 「还没有可用的短描述」；
    //   · 验证码 → S7 拒绝句（readExisting 会把管线注入的「验证码图片」当成可扩写短描述，
    //     于是长描述照样转写验证码字符——识别能力成立，但属安全合规红线，必须在入口拦住）；
    //   · .svg / 坏图 → 走到下面才发现取不到内容（白跑一次 SW 往返）。
    const why = blockReason(el);
    if (why) {
      announceLine(REASON_SAY[why]);
      return;
    }
    const existing = readExisting(el); // 走到这里必定非空（blockReason 已判过 noshort）
    // busy 在 describe 入口已查（requestFor 也前置查过）；此处到 busy=true 之间无 await，
    // 不存在并发窗口。
    busy = true;
    try {
      // 隐私门控（工作单元 8 的闸门，长描述同样不许绕）
      if (window.WS_AI_PRIVACY?.allowed?.() === false) {
        const label = window.WS_AI_PRIVACY.label?.() || '';
        announceLine(`本站点属于${label}类网站，长描述已按隐私保护暂停。可按两次${window.WS_SHORTCUT?.toggle?.() || 'Ctrl+Shift+Z'}强制开启。`);
        return;
      }
      let cfg = {};
      try {
        cfg = (await chrome.storage.local.get('ws_ai_config')).ws_ai_config || {};
      } catch {
        /* 读不到按未配置处理 */
      }
      // 双档口径（2026-10-04）：primary 可留空、default 必填；读键走 WS_AI_SLOTS（含旧名回退）
      // 2026-11-03：主开关与模型分开报（同 page-qa，原因见 ai-slots.js 的 enabled()）
      const visionReady = window.WS_AI_SLOTS?.visionReady?.(cfg) === true;
      if (window.WS_AI_SLOTS?.enabled?.(cfg) !== true) {
        announceLine('图片长描述不可用：设置页「智能功能的用途与开关」目前关闭，请启用后再试。');
        return;
      }
      if (!visionReady) {
        const src = cfg?.provider === 'builtin-relay' ? '公益中转' : '「使用自己的接口」';
        announceLine(`图片长描述不可用：当前接口来源是${src}，但没有可用的视觉模型。请在设置页「大模型接口」里补上视觉模型并保存。`);
        return;
      }

      const src = absoluteSrc(el);
      if (!src) {
        // 兜底：blockReason 已按 'nonbitmap'/'broken' 拦过，正常走不到这里
        announceLine('这张图片取不到有效地址，无法生成长描述。');
        return;
      }
      // 非位图图源（`.svg`）与 image-pipeline 的 isNonBitmapSource 短路同一原则（2026-10-11
      // ⑭ 取证）：`data:`/`blob:` 已由 absoluteSrc 返回 '' 本地拦下；剩下的 http(s) `.svg`
      // 会白跑一次 SW 往返 —— 且按 ⑭ 实测，SVG 原文会被 base64 **送进模型**（downscale 吞掉
      // 解码失败）后才失败，即**真花一次模型调用**。这里本地即按同一归因文案失败，省掉它。
      // 文案与 failureMessage('不支持的图片地址协议') 逐字同源 ⇒ 与走真实路径的用户可听结果
      // 完全一致（坏 .svg 走真实路径得 '取图失败…'，两条失败在本函数里映射到同一句）。
      if (/\.svg(?:[?#]|$)/i.test(src)) {
        // 兜底（blockReason 已拦）：文案与 failWith 同源，两条失败在用户耳朵里完全一致
        failWith(src, '不支持的图片地址协议');
        return;
      }

      // 播报目标图的短描述（2026-10-03）：定位在「不产生滚动的 G 步进」上有物理上限
      //（见 locateImage 注释），先报出目标，图选错了在 15–30 秒等待开始前就能发现。
      announceLine(`正在生成「${clean(existing.text, 20)}」的长描述，请稍候。`);
      // 视觉通道（SW 侧取图 + 专用长描述提示词）：kind 'long' 在 SW/vision 白名单内。
      // 内容侧 90 秒硬看门狗（2026-10-04 owner「很多时候一到后面快捷键就不反应了」）：
      // SW 若在调用中途被杀/消息通道挂死，这个 await 可能**永不落定** → busy 永久
      // 卡住 → 之后每次按键只剩「生成中」一句。race 一颗 90s 定时炸弹保证 busy 必然
      // 复位、失败必然被播报（SW 自己的 60s 超时正常时先到，本狗只是兜底）。
      const res = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'WS_DESCRIBE_IMAGE',
          url: src,
          context: aroundText(el, 120),
          kind: 'long',
        }),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '接口响应超时（超过 90 秒无任何响应）' }), LONGDESC_WATCHDOG_MS)),
      ]);
      // 2026-10-02 owner 实测真缺陷（本项目第二例「静默吞错」）：失败原因曾被整条丢掉，
      // 不管是哪种失败都只播「这次没有取到更长的描述，请稍后再试」。而「请稍后再试」
      // 对**永不自动恢复**的失败是有害指引——实测把密钥金库锁上后，长描述 17ms 就失败，
      // 用户（与开发者）听到的还是「稍后再试」，于是反复重试、永远查不出真因。
      // 改为：诊断留痕（console，前缀 [WennSicht]）+ 按失败原因分流播报，
      // 口径与 image-pipeline.aiFailureMessage 同源。
      if (!res?.ok) {
        failWith(src, String(res?.error || '接口未返回内容'));
        return;
      }
      // 2026-11-03：上限 400 → 1200。长描述的硬要求是「图中文字完整转录」，
      // 400 字会把票据/表格类图片的文字截在半句（提示词那边已改为「转录不设上限、
      // 说明部分 200 字以内」）。1200 只是防跑飞的兜底，正常图片用不到。
      // OCR 通道（res.ocr=true，代码级判定纯文字图）按 owner 要求**不限字数**：
      // 兜底放到 8000，与 SW 侧 vision.js 的截断一致。
      const clamp = res?.ocr ? 8000 : 1200;
      let description = window.WS_SANITIZE
        ? window.WS_SANITIZE.cleanText(res.description, clamp)
        : String(res.description).slice(0, clamp);
      if (!description) {
        failWith(src, '模型未返回有效描述');
        return;
      }

      // 纯信息图后缀（口径：长描述文本 + 决策模型；判定失败走本地数据点特征）
      const verdict = await judgeInfographic(description);
      const isInfo = verdict === null ? isInfographicText(description) : verdict;
      const line = `长描述：${description}` + (isInfo ? INFOGRAPHIC_SUFFIX : '');
      announceLine(line);
    } catch (err) {
      failWith(absoluteSrc(el), String(err?.message || err));
    } finally {
      busy = false;
    }
  }

  // ---------- 失败分流 ----------
  // 「请稍后再试」只对**真的会自愈**的失败（模型偶发空返回）成立。
  // 金库锁定 / 未配置密钥 / 取图 404 / 超时各有各的下一步，必须分开说；
  // 归到一句「请稍后再试」会把用户和开发者都指向错误的排查方向（与
  // image-pipeline.aiFailureMessage 同一教训，后者是 2026-10-01 owner 实测抓出的）。
  function failureMessage(err) {
    if (/金库|密钥/.test(err)) {
      return '长描述生成失败：未能读取 API 密钥，请在设置页确认密钥金库已解锁。';
    }
    if (/取图失败|不支持的图片地址协议|HTTP \d{3}|不是图片|无法解码/.test(err)) {
      return '这张图片取不到内容（链接失效或格式不支持），无法生成长描述。';
    }
    if (/超时/.test(err)) return '长描述生成失败：接口响应超时，可稍后重试。';
    // 模型返回空（思考模型在 max_tokens 内思考完就没预算写正文，或接口回空）——确实可重试，
    // 但要说清是「模型没给内容」而不是笼统的「没有取到描述」。
    if (/接口未返回内容|模型未返回有效描述/.test(err)) {
      return '长描述生成失败：模型这次没有返回内容，可稍后重试。';
    }
    return '长描述生成失败：' + clean(err, 60);
  }

  // 统一失败出口：留痕 + 播报，绝不静默返回。
  function failWith(src, err) {
    console.warn('[WennSicht] 长描述失败：', src, err);
    announceLine(failureMessage(err));
  }

  // 经 content.js 的播报通道（唯一的 live region）说话；ctx 未接（增强未开启）时
  // 只会发生在「未开启按快捷键」——content.js 侧已拦截并提示先开启，这里仅剩兜底。
  function announceLine(text) {
    if (ctx?.announce) {
      ctx.announce(text);
      return;
    }
    // 兜底：自建一次性 polite region（150ms 挂钩等待，见 REFERENCE 坑清单）
    try {
      const r = document.createElement('div');
      r.setAttribute('role', 'status');
      r.setAttribute('aria-live', 'polite');
      r.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);';
      document.body.appendChild(r);
      setTimeout(() => {
        r.textContent = text;
        setTimeout(() => r.remove(), 4000);
      }, 150);
    } catch {
      /* 无 body 等极端场景放弃 */
    }
  }

  return {
    attach: (context) => {
      ctx = context || null;
    },
    detach: () => {
      teardownPicker(); // 增强关闭时若选图对话框还开着，一并收掉（不做焦点交接：正在还原页面）
      dropSink();
      ctx = null;
      busy = false;
    },
    requestFor,
    locateImage,
    listViewportCandidates,
    closePicker,
    // 供回归验证（纯本地，零 AI）
    failureMessage,
    isInfographicText,
    readExisting,
    aroundText,
    absoluteSrc,
    INFOGRAPHIC_SUFFIX,
  };
})();
