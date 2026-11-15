// WennSicht 公益中转接入层（Service Worker 侧，经 importScripts 加载）
// 2026-10-07 会话 20：公测口径 = AI 默认启用、出厂走官方公益中转，用户零配置可用。
//
// ⚠️ 密钥与模型信息隔离铁律（owner 2026-10-07 原话）：
//   「所有 apikey，provider，model 等公益云 model 信息必须我手动来，
//     你不允许读取 apikey 等任何信息」
// 因此本文件**绝不包含**任何真实服务商地址、模型 ID 或密钥：
//   - 上游服务商与真实模型 ID 只存在于中转服务端（Cloudflare Worker 环境变量，
//     owner 手动维护，见工作区 relay/DEPLOY.md）。扩展对中转只发本文件定义的
//     三个**角色别名**——它们是线路协议常量，不是任何云端模型的信息。
//   - 换模型 / 换上游服务商 = 服务端改环境变量，扩展零改动零重发。
//   - 中转端点 URL 是唯一需要写进扩展的值（下方 ENDPOINT_DEFAULT，owner 打包前
//     填写）；它不是机密——服务靠配额与白名单防滥用，不靠端点保密。
//
// 角色别名协议（wire protocol，扩展 ↔ 中转的固定契约）：
//   ws-text   —— 文本角色（页面摘要 / 页面问答等）
//   ws-vision —— 视觉角色（图片描述 / 图表描述）
//   ws-jev    —— 分类角色（决策模型调用，固定走默认档；别名字符串属线路协议，
//                与中转 Worker 的 ALIAS_FIELDS 绑定，未重发中转前不得改动）
//
// 本地/联调覆盖：storage.local 的 ws_relay_endpoint 优先于 ENDPOINT_DEFAULT
//（开发用 dev/mock-relay.mjs 时设置； Emergency 时 owner 也可借此改道，无需重发扩展）。

const WS_RELAY = (() => {
  // ↓↓↓ 公测出厂端点（2026-10-08 会话 21 预填；域名来自 DNSHE：wennlicht.us.ci，
  //      部署步骤见工作区 relay/DEPLOY.md）。
  //      留空 = 公益中转不可用（出厂默认退回「openai-compatible + 手动配置」的旧行为）。
  //      ⚠️ 改这一行 = 改公测端点：必须同步 manifest 的 host_permissions 与
  //      dev/verify-relay.mjs 的端点断言（us.ci 在公共后缀表内，host 权限只能写精确主机名）。
  const ENDPOINT_DEFAULT = 'https://api.wennlicht.us.ci/v1';

  const ALIASES = { text: 'ws-text', vision: 'ws-vision', decision: 'ws-jev' };

  // /ws/config 缓存有效期：额度与状态展示信息，无需实时
  const CONFIG_TTL_MS = 6 * 60 * 60 * 1000;

  const CLIENT_KEYS = { endpoint: 'ws_relay_endpoint', config: 'ws_relay_config', device: 'ws_device_id' };

  function normalizeBase(url) {
    const s = String(url || '').trim().replace(/\/+$/, '');
    return s;
  }

  // 生效端点：覆盖值（存储）> 构建内置值；两者皆空表示公益中转未配置
  async function endpoint() {
    let override = '';
    try {
      const st = await chrome.storage.local.get(CLIENT_KEYS.endpoint);
      override = normalizeBase(st?.[CLIENT_KEYS.endpoint]);
    } catch { /* 存储不可用时只用内置值 */ }
    return override || normalizeBase(ENDPOINT_DEFAULT);
  }

  function isBuiltin(cfg) {
    return cfg?.provider === 'builtin-relay';
  }

  // 设备令牌：本地生成 UUIDv4，持久存 storage.local。它不是机密，用途是
  // 中转侧配额记账（服务端只落哈希，见 relay/worker.js），不是鉴权。
  async function ensureDeviceId() {
    try {
      const st = await chrome.storage.local.get(CLIENT_KEYS.device);
      if (st?.[CLIENT_KEYS.device]) return st[CLIENT_KEYS.device];
    } catch { /* 落入生成路径 */ }
    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try { await chrome.storage.local.set({ [CLIENT_KEYS.device]: id }); } catch { /* 尽力持久 */ }
    return id;
  }

  // 中转请求头（调用方自行决定是否并入）：
  //   X-WS-Device —— 设备令牌（配额记账）
  //   X-WS-Client —— 扩展名/版本（服务端统计口径用，不含任何页面信息）
  async function deviceHeaders() {
    let version = '';
    try { version = chrome.runtime.getManifest?.().version || ''; } catch { /* 忽略 */ }
    return {
      'X-WS-Device': await ensureDeviceId(),
      'X-WS-Client': `wennsicht/${version}`,
    };
  }

  // 带守卫版：仅当该配置确实走公益中转时才返回设备头（供 probe 等共用 fetch 使用）
  async function headersFor(cfg) {
    return isBuiltin(cfg) ? deviceHeaders() : {};
  }

  // 公益中转出厂预配（双档口径里的「默认档」）：接口=端点、模型=别名。
  // 端点未配置时返回 null（设置页据此禁用「公益中转」选项）。
  async function preset() {
    const base = await endpoint();
    if (!base) return null;
    return {
      baseUrl: base,
      textModel: ALIASES.text,
      visionModel: ALIASES.vision,
      decisionModel: ALIASES.decision,
      reasoning: {},
    };
  }

  // ---------- /ws/config：服务能力与配额展示（缓存 6 小时） ----------
  //
  // 只做展示与状态判断用（设置页「公益中转状态」、熔断提示），不参与调用路由；
  // 拉取失败保留 last-known-good（stale:true），中转短抖不致设置页开天窗。

  async function relayConfig() {
    try {
      const st = await chrome.storage.local.get(CLIENT_KEYS.config);
      const c = st?.[CLIENT_KEYS.config];
      return c && typeof c === 'object' ? c : null;
    } catch {
      return null;
    }
  }

  async function fetchRelayConfig({ force = false } = {}) {
    const cached = await relayConfig();
    if (!force && cached?.fetchedAt && Date.now() - cached.fetchedAt < CONFIG_TTL_MS) {
      return { ok: true, ...cached, stale: false, fresh: true };
    }
    const base = await endpoint();
    if (!base) return { ok: false, error: '公益中转端点未配置' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${base}/ws/config`, { headers: await deviceHeaders(), signal: controller.signal });
      if (!res.ok) throw new Error(`公益中转状态接口返回 ${res.status}`);
      const data = await res.json();
      const entry = { fetchedAt: Date.now(), data };
      try { await chrome.storage.local.set({ [CLIENT_KEYS.config]: entry }); } catch { /* 尽力缓存 */ }
      return { ok: true, ...entry, stale: false };
    } catch (err) {
      if (cached) return { ok: true, ...cached, stale: true, error: String(err?.message || err) };
      return { ok: false, error: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ENDPOINT_DEFAULT,
    ALIASES,
    endpoint,
    isBuiltin,
    ensureDeviceId,
    deviceHeaders,
    headersFor,
    preset,
    relayConfig,
    fetchRelayConfig,
  };
})();
