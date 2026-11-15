// WennSicht 大模型接口抽象层（Service Worker 侧，经 importScripts 加载）
// 依赖：similar 模块 WS_SECRETS 需先经 importScripts 载入
//
// 混合智能 fallback（2026-10-04 口径）：双档模型配置
//   primary 前置档 —— 可选；优先承担请求，扩展按 1 次/秒节流使用（留空则只使用默认档）
//   default 默认档 —— 必填；AI 功能的基线，承担全部决策模型调用；
//                     未配置默认档 → AI 功能不可用（运行时直接报明确错误，不用前置档顶替）
// 路由策略（按调用角色）：
//   vision（图片描述/图表/分类）→ **贪心混合**：前置档已配置且令牌桶有空位时
//     走前置档（吃满 1 RPS），桶忙立即溢出到默认档——绝不排队干等；并发由内容侧
//     工作池（8 路）提供，整体吞吐 ≥ 2 张/秒；前置档留空时全部走默认档
//   text（页面摘要等）→ 前置档优先，失败/超时自动落默认档（前置档留空时直接走默认档）
//   决策模型（分类判定，decide()）→ 永远走默认档（用户指定；与默认档共用密钥）
//   tier 显式指定（'primary'|'default'）仅供设置页校验链路用，覆盖自动路由
//
// 密钥处理：配置文件里**不含密钥**。双档密钥由 WS_SECRETS 经 WebCrypto
// 密钥金库保管（槽位 'primary' / 'default'，见 key-vault.js），明文只在使用的
// 那一刻存在于 Service Worker 内存中，永不落盘、永不回显。
//
// Provider 接口契约：
//   {
//     id, label, needsApiKey,
//     defaultBaseUrl, defaultTextModel, defaultVisionModel,
//     chat(params) => Promise<{ text, model, provider }>
//       params: {
//         config,   // 已解析：{ baseUrl, apiKey, model, maxTokens } —— model 已按角色选好
//         messages, // OpenAI 格式；content 可为字符串或多模态数组
//         signal,   // AbortSignal
//       }
//   }

// ---------- 纯文本输出（owner 2026-11-03 硬口径） ----------
// 每一个生成式提示词的最后一句必须一字不差地是下面这句。统一放在请求出口
// （openAiBody / 思考探测）而不是各模块模板里：新增调用方无法漏掉，也不会
// 出现「模板里加了、实际请求忘了」的半成品。
// 决策模型（decide）除外：Decisions API 返回概率而非文本，没有 markdown 可言，
// 加这句只会干扰分类。
const WS_PLAIN_TEXT_SUFFIX = '纯文本输出，不要任何markdown syntax';

function wsEndsWithPlainText(text) {
  return typeof text === 'string' && text.trimEnd().endsWith(WS_PLAIN_TEXT_SUFFIX);
}

// 字符串内容：直接接在末尾；多模态数组：接到最后一个 text part 上
// （图片在前、文字在后仍是合法顺序）；数组里没有 text part 就补一个。
function wsAddPlainTextToContent(content) {
  if (typeof content === 'string') {
    if (wsEndsWithPlainText(content)) return content;
    const head = content.trimEnd();
    return head ? head + '\n\n' + WS_PLAIN_TEXT_SUFFIX : WS_PLAIN_TEXT_SUFFIX;
  }
  if (Array.isArray(content)) {
    const parts = content.slice();
    let lastText = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p && p.type === 'text' && typeof p.text === 'string') { lastText = i; break; }
    }
    if (lastText >= 0) {
      if (wsEndsWithPlainText(parts[lastText].text)) return parts;
      const head = parts[lastText].text.trimEnd();
      parts[lastText] = {
        ...parts[lastText],
        text: head ? head + '\n\n' + WS_PLAIN_TEXT_SUFFIX : WS_PLAIN_TEXT_SUFFIX,
      };
      return parts;
    }
    parts.push({ type: 'text', text: WS_PLAIN_TEXT_SUFFIX });
    return parts;
  }
  return content;
}

// 只加到最后一条 user 消息（真正的「最后一句」）；不修改调用方传入的数组。
// 已带后缀则不重复追加——防止模板与出口同时加时出现两遍。
function wsWithPlainTextSuffix(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) {
    out.push({ role: 'user', content: WS_PLAIN_TEXT_SUFFIX });
    return out;
  }
  out[idx].content = wsAddPlainTextToContent(out[idx].content);
  return out;
}

const WS_AI = (() => {
  const CONFIG_KEY = 'ws_ai_config';
  const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';
  // 公益中转出厂预配（2026-10-07 会话 20 owner 拍板）：构建时内置了中转端点
  // （src/services/relay.js 的 ENDPOINT_DEFAULT）即默认启用 AI 并把默认档指向中转
  //（模型为线路协议别名 ws-text/ws-vision/ws-jev，真实模型只在服务端）。
  // 端点为空（开发构建 / 中转未就位）→ 以下条件全部退回旧行为，零影响。
  const BUILTIN_ENDPOINT = (typeof WS_RELAY !== 'undefined' && WS_RELAY.ENDPOINT_DEFAULT) || '';
  const BUILTIN_ALIASES = (typeof WS_RELAY !== 'undefined' && WS_RELAY.ALIASES) || { text: 'ws-text', vision: 'ws-vision', decision: 'ws-jev' };
  const DEFAULT_CONFIG = {
    provider: BUILTIN_ENDPOINT ? 'builtin-relay' : 'openai-compatible',
    primary: { baseUrl: 'https://openrouter.ai/api/v1', textModel: '', visionModel: '', reasoning: {} },
    default: BUILTIN_ENDPOINT
      ? { baseUrl: BUILTIN_ENDPOINT, textModel: BUILTIN_ALIASES.text, visionModel: BUILTIN_ALIASES.vision, decisionModel: BUILTIN_ALIASES.decision, reasoning: {} }
      : { baseUrl: 'https://openrouter.ai/api/v1', textModel: '', visionModel: '', decisionModel: DEFAULT_DECISION_MODEL, reasoning: {} },
    // 2026-11-03：2048 → 4096。max_tokens 只是上限不是成本（模型说完就停），
    // 但 OCR 长转录（纯文字图逐字读出）在 2048 tokens 会被硬截半句。
    maxTokens: 4096,
    // 免费档在 OpenRouter 常排队 20 秒以上，短超时会把可用模型误判为不可用
    timeoutMs: 60000,
    // 2026-11-03（owner 指定）：全局 temperature 0.2 → 0。本扩展的调用全是
    // 结构化/事实型（摘要/问答/转录/分类），不需要创造性；0 = 同图同问答案稳定，也压低幻觉。
    temperature: 0,
    // 主开关：启用基于智能场景解析的无障碍增强（场景分类/页面摘要/链接意图/图片描述）。
    // 公测出厂（owner 2026-10-07 拍板）：公益中转就位即默认启用（开箱即用）；
    // 无端点的构建维持默认关闭。
    enabled: !!BUILTIN_ENDPOINT,
  };

  // primary 档限速：1 RPS（用户给定的服务端硬限制）。令牌桶间隔式：距上次发放
  // ≥ 1000ms 才允许下一次。检查与占用在同一段同步代码内完成——SW 单线程，
  // 并发 chat() 不可能同时抢到同一个桶位
  const PRIMARY_RPS_INTERVAL_MS = 1000;
  let primaryLastAt = 0;
  // SW 每 30 秒空闲即被杀，重启后内存桶清零会造成突发超 1 RPS——把时间戳
  // 持久到 chrome.storage.session（浏览器会话级，关浏览器即清，非持久状态）。
  // 兼容旧键 ws_main_last_at（改名前的节流记录，一次性读旧写新）
  let limiterReady = Promise.resolve();
  try {
    limiterReady = chrome.storage.session
      .get(['ws_primary_last_at', 'ws_main_last_at'])
      .then((v) => { primaryLastAt = Number(v?.ws_primary_last_at ?? v?.ws_main_last_at) || 0; })
      .catch(() => {});
  } catch {
    /* storage.session 不可用时退化为纯内存桶 */
  }
  function tryTakePrimary() {
    const now = Date.now();
    if (now - primaryLastAt < PRIMARY_RPS_INTERVAL_MS) return false;
    primaryLastAt = now;
    try { chrome.storage.session.set({ ws_primary_last_at: now }); } catch { /* 尽力持久 */ }
    return true;
  }

  // 路由统计（开发验证用）：各档尝试次数
  const stats = { primaryCalls: 0, defaultCalls: 0 };

  const providers = new Map();

  // ---------- 思考/推理（reasoning）控制（2026-09-30 用户需求） ----------
  //
  // 目标：所有模型思考务必关闭（省 token、防思考吃光 max_tokens）。实测
  // （OpenRouter，model_config.txt 的三个模型）行为分三类，无法一套语法通吃：
  //   disablable   —— 基线烧 reasoning token，reasoning:{enabled:false} 后归零
  //                   （ling-3.0-flash-vl：158→0）→ 运行时必发该参数
  //   mandatory    —— 模型强制思考，发 enabled:false 直接 400「cannot be disabled」
  //                   （stealth/space-bunny-alpha；其基线 reasoning=0，无需关）
  //   unsupported  —— 模型根本不产生思考（mistral-nemo）→ 不发参数（保持干净）
  // 模式由 WS_AI_VERIFY（设置页保存时）探测并写入 cfg[tier].reasoning[role]；
  // 运行时按存储模式决定发不发——模型可换，探测机制与平台语法不变。
  const REASONING_PROBE_MAX_TOKENS = 512;

  // 对单个模型实测思考行为，返回 'disablable' | 'mandatory' | 'unsupported' | 'unknown'
  // extraHeaders：公益中转等场景附加的请求头（设备令牌）；apiKey 为空时不带
  // Authorization（公益中转无密钥，带空头反而可能被拒）。
  async function probeReasoningMode(baseUrl, model, apiKey, extraHeaders = {}) {
    const call = async (withDisable) => {
      const body = {
        model,
        messages: wsWithPlainTextSuffix([{ role: 'user', content: '只回复两个字母：ok' }]),
        max_tokens: REASONING_PROBE_MAX_TOKENS,
      };
      if (withDisable) body.reasoning = { enabled: false };
      const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${(baseUrl || '').replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return { status: res.status, data: res.ok ? await res.json().catch(() => null) : null };
    };
    try {
      const base = await call(false);
      if (base.status !== 200 || !base.data) return 'unknown';
      const msg = base.data?.choices?.[0]?.message || {};
      const baseTokens = base.data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const baseField = !!(msg.reasoning || (msg.reasoning_details && msg.reasoning_details.length));

      const dis = await call(true);
      if (dis.status !== 200) return 'mandatory'; // 关不掉 = 模型强制思考（如 space-bunny）
      const disTokens = dis.data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      const disMsg = dis.data?.choices?.[0]?.message || {};
      const disField = !!(disMsg.reasoning || (disMsg.reasoning_details && disMsg.reasoning_details.length));
      if (disTokens === 0 && !disField) return 'disablable';
      if (baseTokens === 0 && !baseField) return 'unsupported';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ---------- Provider 注册表 ----------

  function registerProvider(provider) {
    if (!provider?.id || typeof provider.chat !== 'function') {
      throw new Error('provider 至少需要 { id, chat() }');
    }
    providers.set(provider.id, provider);
    return provider.id;
  }

  function listProviders() {
    return [...providers.values()].map(({ id, label }) => ({ id, label }));
  }

  // ---------- 内置 provider：OpenAI 兼容接口（直连与公益中转共用请求体） ----------

  // 共享请求体构造（两个 provider 的 wire 格式完全一致，模型字段由 callTier 选好：
  // 直连=真实模型 ID；公益中转=角色别名，映射在中转服务端完成）
  function openAiBody(config, messages) {
    const body = {
      model: config.model,
      // 所有生成式调用的最后一句：纯文本输出（见文件顶部 wsWithPlainTextSuffix）
      messages: wsWithPlainTextSuffix(messages),
      max_tokens: config.maxTokens || 512,
      temperature: typeof config.temperature === 'number' ? config.temperature : 0,
    };
    // 思考关闭（能力感知）：探测归类为 disablable 的槽位必发 enabled:false，
    // mandatory/unsupported/unknown 一律不发（发了会 400 或纯属噪音）
    if (config.disableReasoning) body.reasoning = { enabled: false };
    return body;
  }

  // 共享发送与解析
  async function openAiSend(base, headers, body, signal) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`接口返回 ${res.status}：${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口未返回内容');

    return {
      text: typeof content === 'string' ? content : JSON.stringify(content),
      model: data?.model || body.model,
      provider: 'openai-compatible',
    };
  }

  registerProvider({
    id: 'openai-compatible',
    label: 'OpenAI 兼容接口',
    needsApiKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultTextModel: '',
    defaultVisionModel: '',
    async chat({ config, messages, signal }) {
      const base = (config.baseUrl || '').replace(/\/+$/, '');
      if (!base) throw new Error('未配置接口地址');
      if (!config.model) throw new Error('未配置模型');

      const headers = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      return { ...await openAiSend(base, headers, openAiBody(config, messages), signal), provider: 'openai-compatible' };
    },
  });

  // 公益中转 provider（2026-10-07 会话 20）：与 openai-compatible 同一线路格式，
  // 区别只有两点——①不带 Authorization（密钥在中转服务端，扩展侧无密钥可用、
  // 也绝不把金库里的任何密钥发往中转）；②附设备令牌头（配额记账，非机密）。
  // needsApiKey:false → callTier 跳过金库读取，金库未初始化也不影响公益档。
  // 仅在 relay.js 已加载时注册（SW 正常加载必然在位；独立加载 ai.js 的测试环境
  // 优雅缺省，不崩、也不注册公益档）。
  if (typeof WS_RELAY !== 'undefined' && WS_RELAY?.ALIASES) {
    registerProvider({
      id: 'builtin-relay',
      label: '官方公益中转',
      needsApiKey: false,
      defaultBaseUrl: '',
      defaultTextModel: WS_RELAY.ALIASES.text,
      defaultVisionModel: WS_RELAY.ALIASES.vision,
      async chat({ config, messages, signal }) {
        const base = (config.baseUrl || '').replace(/\/+$/, '');
        if (!base) throw new Error('公益中转端点未配置');
        if (!config.model) throw new Error('未配置模型');

        const headers = { 'Content-Type': 'application/json', ...(await WS_RELAY.deviceHeaders()) };

        const r = await openAiSend(base, headers, openAiBody(config, messages), signal);
        return { ...r, provider: 'builtin-relay' };
      },
    });
  }

  // ---------- 配置读写与迁移 ----------

  // 历史遗留迁移（一次性执行）：
  //   v0 平铺 { baseUrl, textModel, visionModel, hasApiKey, apiKey? } → 双档
  //   v1 旧槽名 main/back → primary/default（2026-10-04 口径迁移）
  //   平铺单档 → default（新口径下 default 是必填基线，单档用户直接成为默认档）
  //   曾把 apiKey 明文写进配置 → 搬进加密存储 default 槽并删除
  //   曾有单一 model 字段 → 迁为 visionModel
  //   旧字段名 jevModel → decisionModel（2026-10-11 术语统一：分类模型 → 决策模型）
  async function migrateLegacyConfig() {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const cfg = stored?.[CONFIG_KEY];
    if (!cfg || typeof cfg !== 'object') {
      // 全新安装（2026-11-03 修）：把出厂主开关**写实**。
      // 内容脚本读的是原始存储、不走本文件的 DEFAULT_CONFIG 合并；存储里没有
      // enabled 这个字段，它们就会把「出厂默认开启」判成关闭——设置页勾着，
      // 页面却播「请先在设置页启用…」。写一次之后一律以存储为准。
      if (BUILTIN_ENDPOINT) {
        try {
          await chrome.storage.local.set({ [CONFIG_KEY]: { enabled: true } });
        } catch {
          // 存储不可用：下一次 SW 冷启动再试
        }
      }
      return;
    }

    let changed = false;

    const legacyPlain = cfg.apiKey;
    if (typeof legacyPlain === 'string' && legacyPlain) {
      try {
        await WS_SECRETS.saveApiKey('default', legacyPlain);
        cfg.hasDefaultKey = true;
      } catch {
        // 金库锁定等场景：留待用户解锁后重新保存，不阻塞配置迁移
      }
      changed = true;
    }
    if ('apiKey' in cfg) {
      delete cfg.apiKey; // 无论内容如何，一律从配置中移除
      changed = true;
    }

    if (cfg.model && !cfg.visionModel) {
      cfg.visionModel = cfg.model; // 旧的单槽位当时只用于图片描述
      changed = true;
    }
    if ('model' in cfg) {
      delete cfg.model;
      changed = true;
    }

    // 字段改名（2026-10-11）：jevModel → decisionModel（术语统一为「决策模型」）。
    // 三类历史形态都要认：v0 顶层平铺、v1 旧槽 main/back、现行 default 槽。
    // 先在本段归位，再走下面的两档结构迁移——否则旧名不会被当新名读到，
    // 用户已保存的决策模型会被 DEFAULT_CONFIG 静默顶掉（等于丢配置）。
    if ('jevModel' in cfg) {
      if (!cfg.decisionModel && cfg.jevModel) cfg.decisionModel = cfg.jevModel;
      delete cfg.jevModel;
      changed = true;
    }
    for (const slotName of ['primary', 'default', 'main', 'back']) {
      const s = cfg[slotName];
      if (s && typeof s === 'object' && 'jevModel' in s) {
        if (!s.decisionModel && s.jevModel) s.decisionModel = s.jevModel;
        delete s.jevModel;
        changed = true;
      }
    }

    // 双档结构就位（含旧槽名改名与平铺单档归位）
    if (!cfg.primary || !cfg.default) {
      // v1 旧槽名 main/back → primary/default（逐字搬，语义不变）
      if (cfg.main || cfg.back) {
        cfg.primary = cfg.main || { ...DEFAULT_CONFIG.primary };
        cfg.default = cfg.back || { ...DEFAULT_CONFIG.default };
        delete cfg.main;
        delete cfg.back;
        changed = true;
      }
      // v0 平铺单档 → default（基线档必填：旧用户唯一一档直接成为默认档，
      // 前置档留空即可——路由自动只使用默认档）
      if (cfg.baseUrl || cfg.textModel || cfg.visionModel || cfg.decisionModel) {
        cfg.default = {
          ...(cfg.default || DEFAULT_CONFIG.default),
          baseUrl: cfg.baseUrl || cfg.default?.baseUrl || DEFAULT_CONFIG.default.baseUrl,
          textModel: cfg.textModel || cfg.default?.textModel || '',
          visionModel: cfg.visionModel || cfg.default?.visionModel || '',
          decisionModel: cfg.decisionModel || cfg.default?.decisionModel || DEFAULT_DECISION_MODEL,
        };
        delete cfg.baseUrl;
        delete cfg.textModel;
        delete cfg.visionModel;
        delete cfg.decisionModel;
        changed = true;
      }
    } else if (cfg.main || cfg.back) {
      // 双档已就位但残留旧槽名键：清掉，避免两份配置共存歧义
      delete cfg.main;
      delete cfg.back;
      changed = true;
    }
    delete cfg.hasApiKey; // 密钥状态改由 WS_KEY_STATE 双槽查询，不再进配置
    if ('hasApiKey' in cfg) changed = true;

    // 出厂预配落盘（2026-11-03 修②，owner 实测配置取证）：
    //   实况存储是 `{enabled:true, hasDefaultKey:false, hasPrimaryKey:false}` ——
    //   用户只在「智能功能的用途与开关」点了保存，从没保存过「大模型接口」。
    //   SW 侧有 DEFAULT_CONFIG 兜着，转发其实还能跑；内容脚本读的是**原始存储**，
    //   没有 default 槽 ⇒ textReady 判 false ⇒ 页面永远播「请先配置文本模型」。
    //   把出厂预配原样写进存储，两侧从此一致（设置页也会正常回显「公益中转」）。
    //   条件收紧：一个槽位都没有、用户没显式选过自定义接口、构建确实内置了端点。
    const noSlot = !cfg.default && !cfg.back && !cfg.baseUrl
      && !cfg.textModel && !cfg.visionModel && !cfg.decisionModel
      && !(cfg.primary && (cfg.primary.baseUrl || cfg.primary.textModel || cfg.primary.visionModel));
    if (noSlot && cfg.provider !== 'openai-compatible' && BUILTIN_ENDPOINT) {
      cfg.provider = 'builtin-relay';
      // 前置档留空（与设置页「公益中转」保存时的形状逐字一致，见 options.js saveBuiltinAi）
      cfg.primary = { baseUrl: '', textModel: '', visionModel: '', reasoning: {} };
      cfg.default = { ...DEFAULT_CONFIG.default };
      changed = true;
    }

    // 密钥布尔自愈（一次性）：改名后存储里可能还是旧 hasMainKey/hasBackKey
    if (
      cfg.hasPrimaryKey === undefined ||
      cfg.hasDefaultKey === undefined ||
      cfg.hasMainKey !== undefined ||
      cfg.hasBackKey !== undefined
    ) {
      try {
        const has = await WS_SECRETS.hasApiKeys();
        cfg.hasPrimaryKey = has.primary;
        cfg.hasDefaultKey = has.default;
        delete cfg.hasMainKey;
        delete cfg.hasBackKey;
        changed = true;
      } catch {
        // 金库不可用时留给下次迁移
      }
    }

    // 图片描述旧开关迁移：ws_image_config.enabled=true → 主开关开启（一次性）
    if (cfg.enabled === undefined || cfg.enabled === null) {
      try {
        const img = await chrome.storage.local.get('ws_image_config');
        if (img?.ws_image_config?.enabled === true) {
          cfg.enabled = true;
          changed = true;
        }
      } catch {
        // 读取失败不影响迁移其余部分
      }
    }

    // 主开关兜底（2026-11-03 修，与上面同因）：老配置里没有 enabled 时按出厂口径写实。
    // 只补「字段不存在」——用户显式关过（false）绝不翻回来。
    if (typeof cfg.enabled !== 'boolean') {
      cfg.enabled = !!BUILTIN_ENDPOINT;
      changed = true;
    }

    if (changed) await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  }

  async function getConfig() {
    await migrateLegacyConfig();
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const raw = stored?.[CONFIG_KEY] || {};
    const cfg = {
      ...DEFAULT_CONFIG,
      ...raw,
      primary: { ...DEFAULT_CONFIG.primary, ...(raw.primary || {}) },
      default: { ...DEFAULT_CONFIG.default, ...(raw.default || {}) },
    };
    // 任何情况下都不把密钥带回配置对象；旧槽名残留不进入运行对象
    delete cfg.apiKey;
    delete cfg.main;
    delete cfg.back;
    delete cfg.hasMainKey;
    delete cfg.hasBackKey;
    // owner 2026-11-03 硬口径：全局 temperature = 0。老配置里残留的 0.2 会通过
    // `...raw` 覆盖默认值（实测 0.2.0 存量配置仍在发 0.2），所以在运行对象上强制归零，
    // 不依赖用户重装或手改存储。
    cfg.temperature = 0;
    // 兜底：迁移写盘失败（存储异常）时仍认旧字段名，绝不静默丢用户已保存的决策模型
    const rawHasOwnDecision = !!(raw.default?.decisionModel || raw.back?.decisionModel || raw.decisionModel);
    const legacyDecision = raw.default?.jevModel || raw.back?.jevModel || raw.jevModel;
    if (!rawHasOwnDecision && legacyDecision) cfg.default.decisionModel = legacyDecision;
    // 密钥布尔与加密存储的真实状态对齐（SW 内存缓存金库结果，开销可忽略）——
    // 避免迁移/清密钥后标志与实际不一致
    try {
      const has = await WS_SECRETS.hasApiKeys();
      cfg.hasPrimaryKey = has.primary;
      cfg.hasDefaultKey = has.default;
    } catch {
      cfg.hasPrimaryKey = false;
      cfg.hasDefaultKey = false;
    }
    return cfg;
  }

  // 只接受非敏感字段；密钥必须走 WS_SECRETS.saveApiKey()
  async function saveConfig(partial) {
    const current = await getConfig();
    const next = { ...current, ...(partial || {}) };
    // 兼容旧槽名入参（热重载窗口里旧调用方残留）：main→primary、back→default
    const primaryPartial = partial?.primary || partial?.main;
    const defaultPartial = partial?.default || partial?.back;
    if (primaryPartial) next.primary = { ...current.primary, ...primaryPartial };
    if (defaultPartial) next.default = { ...current.default, ...defaultPartial };
    delete next.apiKey; // 防御：即使误传也绝不落盘
    delete next.main;
    delete next.back;
    delete next.hasMainKey;
    delete next.hasBackKey;
    // 防御：旧字段名一律不落盘（避免新旧两份模型名共存造成歧义）
    delete next.jevModel;
    if (next.default) delete next.default.jevModel;
    if (next.primary) delete next.primary.jevModel;
    await chrome.storage.local.set({ [CONFIG_KEY]: next });
    return next;
  }

  // ---------- 权限与调用 ----------

  function apiOrigin(tierCfg) {
    try {
      return new URL(tierCfg.baseUrl).origin;
    } catch {
      return null;
    }
  }

  async function hasApiPermission(tierCfg) {
    const origin = apiOrigin(tierCfg);
    if (!origin) return false;
    try {
      return await chrome.permissions.contains({ origins: [origin + '/*'] });
    } catch {
      return false;
    }
  }

  function modelForRole(tierCfg, role) {
    return role === 'vision' ? tierCfg.visionModel : tierCfg.textModel;
  }

  // 档位显示名（错误消息/学生播报口径 2026-10-04）
  const TIER_LABEL = { primary: '前置档', default: '默认档' };

  // 单档执行：解析该档配置 → 校验 → 取该档密钥 → 带超时调 provider.chat
  async function callTier(tier, role, messages, cfg, provider) {
    const tierCfg = cfg[tier];
    const label = TIER_LABEL[tier] || tier;
    const model = modelForRole(tierCfg, role);
    if (!tierCfg.baseUrl) throw new Error(`未配置${label}接口地址`);
    if (!model) throw new Error(role === 'vision' ? `未配置${label}视觉模型` : `未配置${label}文本模型`);

    // 密钥只对需要密钥的 provider 读取（公益中转 needsApiKey:false——金库未解锁/
    // 未初始化都不影响公益档；也绝不把金库密钥带进中转请求）
    const keys = provider.needsApiKey ? await WS_SECRETS.loadApiKeys() : {};
    const apiKey = keys[tier] || '';
    if (provider.needsApiKey && !apiKey) throw new Error(`未配置${label}API 密钥`);

    if (!(await hasApiPermission(tierCfg))) {
      const origin = apiOrigin(tierCfg);
      throw new Error(`尚未授权访问${label}接口 ${origin || ''}，请在设置页保存该档配置时完成授权`);
    }

    stats[tier === 'primary' ? 'primaryCalls' : 'defaultCalls']++;

    const resolved = {
      ...tierCfg,
      model,
      apiKey,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      // 思考关闭参数只发给探测归类为 disablable 的槽位/角色（能力感知，见文件头）
      disableReasoning: tierCfg.reasoning?.[role] === 'disablable',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 60000);
    const doCall = (conf) => provider.chat({ config: conf, messages, signal: controller.signal });
    try {
      try {
        return { ...(await doCall(resolved)), tier };
      } catch (err) {
        // 思考关闭参数被模型拒绝（如 space-bunny 这类强制思考模型，400「cannot be
        // disabled」）→ 自动去参数重试一次，并把探测模式自愈为 mandatory。
        // 全自动闭环：保存时探测定型 → 运行时按定型发参数 → 撞墙自愈改型
        //（模型被换但没重跑校验时，运行时也能自我纠正，无需人工介入）
        if (resolved.disableReasoning && /接口返回 400|cannot be disabled|reasoning is mandatory/i.test(String(err?.message || err))) {
          const r = await doCall({ ...resolved, disableReasoning: false });
          try {
            await saveConfig({ [tier]: { reasoning: { ...(cfg[tier]?.reasoning || {}), [role]: 'mandatory' } } });
          } catch { /* 自愈写盘失败不影响本次结果 */ }
          return { ...r, tier };
        }
        throw err;
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`请求超时（${(cfg.timeoutMs || 60000) / 1000} 秒）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // 门面调用：按混合 fallback 策略路由。
  // role: 'text' | 'vision'；tier: 显式 'primary' | 'default'（校验用，覆盖自动路由）。
  // 口径（2026-10-04，2026-11-15 补充）：default 是必填基线——未配置时 AI 功能不可用，
  // 直接报明确错误，不用前置档顶替；primary 可选，且**按角色回落**：
  //   primary 只填了文本模型时，视觉请求直接走 default（反之亦然），
  //   不做跨档拼装（不会拿 primary 的 baseUrl 配 default 的模型名）。
  // 刻意不接受任何配置覆盖：配置只来自已保存的 ws_ai_config，密钥只来自
  // 加密存储 —— 调用方（包括内容脚本消息）只能选择角色，不能触碰其余。
  async function chat(messages, { role = 'text', tier } = {}) {
    await limiterReady; // 令牌桶时间戳就绪后再做路由决定
    const cfg = await getConfig();

    const provider = providers.get(cfg.provider || 'openai-compatible');
    if (!provider) throw new Error(`未注册的 provider：${cfg.provider}`);

    const primaryReady = !!(cfg.primary.baseUrl && modelForRole(cfg.primary, role));
    const defaultReady = !!(cfg.default.baseUrl && modelForRole(cfg.default, role));

    let useTier;
    if (tier) {
      // 显式指定（设置页校验）：失败也不自动换档；容忍旧槽名入参
      useTier = tier === 'main' ? 'primary' : tier === 'back' ? 'default' : tier;
    } else if (!defaultReady) {
      // 默认档必填：让 callTier 报出「未配置默认档…」的明确错误（
      // 而不是晴默用前置档顶替——那会让「默认档为空」变成看不见的隐患）
      return callTier('default', role, messages, cfg, provider);
    } else if (primaryReady) {
      // 贪心混合：前置档桶有空位走前置档（吃满 1 RPS）；桶忙立即溢出默认档，
      // 绝不排队干等；文本调用则前置档优先
      useTier = role === 'vision'
        ? (tryTakePrimary() ? 'primary' : 'default')
        : 'primary';
    } else {
      useTier = 'default'; // 前置档留空：只使用默认档
    }

    if (useTier === 'primary') {
      try {
        return await callTier('primary', role, messages, cfg, provider);
      } catch (err) {
        if (tier === 'primary' || tier === 'main') throw err; // 显式校验：不落默认档
        if (!defaultReady) throw err;
        // 自动路由的兜底：前置档失败（含密钥/权限问题）→ 默认档接管
        return await callTier('default', role, messages, cfg, provider);
      }
    }
    return callTier('default', role, messages, cfg, provider);
  }

  // ---------- 决策调用（决策模型，走 Decisions API） ----------
  //
  // 与 chat 的区别：不生成文本，对 state 回答类型化问题并返回概率。
  // 永远走 default 档（2026-09-30 用户指定：决策模型调用不占前置档的 1 RPS；
  // 2026-10-04 口径沿用——分类调用固定在默认档）。
  // state：页面信号对象（标题/路径/文本样本/统计信号）
  // questions：{ 问题名: { type: 'choice'|'noul'|'score', instructions, criteria } }
  // 返回：answers 对象（每题含 choice/noul/score + probabilities + confidence）
  async function decide(state, questions) {
    const cfg = await getConfig();
    const dft = cfg.default;
    if (!dft.decisionModel) throw new Error('未配置决策模型（默认档）');
    if (!dft.baseUrl) throw new Error('未配置默认档接口地址');

    // 公益中转档（2026-10-07）：无密钥可用也不要求密钥，附设备令牌头；
    // URL 构造与直连一致（baseUrl 含 /v1 → origin 根 + /api/alpha/decisions，
    // 中转 Worker 按同路径代理并完成别名→真实模型映射）。
    const builtin = cfg.provider === 'builtin-relay';
    const keys = await WS_SECRETS.loadApiKeys();
    const apiKey = keys.default || '';
    if (!apiKey && !builtin) throw new Error('未配置默认档 API 密钥');

    if (!(await hasApiPermission(dft))) {
      const origin = apiOrigin(dft);
      throw new Error(`尚未授权访问默认档接口 ${origin || ''}，请在设置页保存默认档配置时完成授权`);
    }

    stats.defaultCalls++;

    // Decisions API 端点 = 接口源 + /api/alpha/decisions
    // （baseUrl 形如 https://openrouter.ai/api/v1 → origin https://openrouter.ai）
    const origin = apiOrigin(dft);
    const url = origin + '/api/alpha/decisions';

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (builtin && typeof WS_RELAY !== 'undefined') Object.assign(headers, await WS_RELAY.deviceHeaders());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        // 决策调用返回结构化概率，不是可朗读文本 → 不追加「纯文本输出」指令
        body: JSON.stringify({ model: dft.decisionModel, state, questions }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`决策接口返回 ${res.status}：${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.answers || {};
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`决策请求超时（${(cfg.timeoutMs || 60000) / 1000} 秒）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    probeReasoningMode,
    registerProvider,
    listProviders,
    getConfig,
    saveConfig,
    hasApiPermission,
    apiOrigin,
    chat,
    decide,
    getStats: () => ({ ...stats }),
    resetStats: () => { stats.primaryCalls = 0; stats.defaultCalls = 0; },
    DEFAULT_CONFIG,
  };
})();
