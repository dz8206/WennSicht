// 循光WennSicht 首次使用引导（会话 58）—— 独立、一次性、**每项设置当场可改并保存**的向导页。
//
// owner 2026-11-09 定案（覆盖会话 56 的「只解释、让用户记待办」形态）：
//   ① 引导页要让用户**就在这里改设置**，不是列 16 条待办事项；
//   ② 走完引导时 **11 项设置全部已经配置好**（每项都有明确写入的值）；
//   ③ 最后一屏必须**明确告知**：点这个按钮会自动关闭本网页，之后就可以用 循光WennSicht 浏览了；
//   ④ 只在首次安装出现一次；设置页只留一个小的「重新走一遍」入口。
//
// 实现要点：
//   - 每个设置一屏，屏上就是真实控件（复选框 / 数字 / 文本框 / 单选），改动立即写入真实存储键；
//   - 结束时再整体落盘一次 + 写 `ws_welcome_config`（11 项配置的完整审计） → 保证「全部已配置」；
//   - 需要网站授权的项（全局启用 / 添加站点）只在用户**主动改控件**时申请，用户手势内首个异步调用
//     就是 permissions.request（技能规则 20），不会因为 await 丢失手势；默认关闭时绝不弹框；
//   - 演示区是本地模拟，不调用任何 AI、不打开反馈窗口、不联网。
//   - 品牌口径：**面向用户的文案一律写「循光WennSicht」**，拉丁名绝不单独出现。

const $ = (id) => document.getElementById(id);
// 2026-11-10：密钥金库不再单独编号，改为「设置 7 的补充」（只在自己接口时出现），
// 所以编号设置变成 10 项；金库仍会写进 ws_welcome_config，只是不计入编号。
const TOTAL_SETTINGS = 10;

// 由 ../data/content-files.js 提供（welcome.html 已先加载）
const CFG_FILES = globalThis.WS_CONTENT_FILES || [];
const GLOBAL_SCRIPT_ID = globalThis.WS_GLOBAL_SCRIPT_ID || 'wennsicht-global';
const siteScriptId = globalThis.WS_siteScriptId
  || ((origin) => 'wennsicht-site-' + String(origin).replace(/[^a-z0-9]/gi, '-').toLowerCase());

let state = {};       // 存储原状（用于保留既有条目，不覆盖用户已有配置）
let config = {};      // 11 项显式配置（每项都有值）
let commands = [];
// 会话 74（owner）：页面里凡是写快捷键的地方都跟用户**实际绑定**走，不再写死 Ctrl+Shift+Z。
let TOGGLE_KEY = 'Ctrl+Shift+Z';
function setToggleKey(list) {
  const c = (list || []).find((x) => x && x.name === 'toggle-wennsicht');
  if (c && c.shortcut) TOGGLE_KEY = c.shortcut;
}
let idx = 0;

// ---------- 存储 ----------
async function readState() {
  const s = await chrome.storage.local.get([
    'ws_global', 'ws_sites', 'ws_sensitive_sites', 'ws_ai_config',
    'ws_image_config', 'ws_ui_config', 'ws_live_sites', 'ws_active_sites',
  ]);
  state = {
    raw: s,
    ws_sites: s.ws_sites || {},
    ws_sensitive_sites: s.ws_sensitive_sites || {},
    ws_live_sites: s.ws_live_sites || {},
    ws_active_sites: s.ws_active_sites || {},
  };
  const ai = s.ws_ai_config || {};
  const img = s.ws_image_config || {};
  const ui = s.ws_ui_config || {};
  const rawLimit = Number(img.dailyLimit);
  // 2026-11-10 owner：新增「要不要设上限」复选框。**老数据没有 limitEnabled** ⇒ 按
  // dailyLimit>0 推断，保证已有用户行为不变（原来 0 就等于不设上限）。
  const limitValid = Number.isFinite(rawLimit) && rawLimit >= 0;
  const limitOn = img.limitEnabled === true
    || (img.limitEnabled == null && limitValid && rawLimit > 0);
  config = {
    global: s.ws_global === true,
    sites: Object.keys(state.ws_sites),
    sensitiveProtect: Object.keys(state.ws_sensitive_sites).length === 0,
    sensitive: Object.keys(state.ws_sensitive_sites),
    aiEnabled: ai.enabled !== false,
    limitEnabled: limitOn,
    dailyLimit: limitValid ? Math.max(0, Math.round(rawLimit)) : 100,
    hoverReplay: !!img.hoverReplay,
    provider: ai.provider === 'openai-compatible' ? 'own' : 'relay',
    own: {
      baseUrl: ai.default?.baseUrl || '',
      textModel: ai.default?.textModel || '',
      visionModel: ai.default?.visionModel || '',
      decisionModel: ai.default?.decisionModel || '',
    },
    vaultSaved: false,   // 密钥是否已加密存好（存过就不必再逼用户重填两个密码框）
    ownTestFailed: false, // 「自己的接口」测过一次失败后，允许用户再按一次直接继续
    announceChanges: ui.announceChanges !== false,
    positionMemory: ui.positionMemory !== false,
    live: Object.keys(state.ws_live_sites),
  };
}
async function obj(key) {
  return (await chrome.storage.local.get(key))[key] || {};
}
async function mergeWrite(key, patch) {
  await chrome.storage.local.set({ [key]: { ...(await obj(key)), ...patch } });
}

// 保存「自己的接口」用的密钥。金库要求先有主密码，所以这一动作同时做两步：
// WS_KEY_SETUP（设主密码）→ WS_KEY_SAVE（加密存 default 槽的密钥）。
// 返回 '' 表示成功；否则是给用户看的错误文案。
async function ensureVaultSaved() {
  if (config.vaultSaved) return '';
  // 2026-11-10：主密码并进「设置 7」同一屏，输入框 id 随之改为 w-own-pass / w-own-key
  const pass = $('w-own-pass')?.value || '';
  const key = $('w-own-key')?.value || '';
  if (!pass || !key) return '主密码和接口密钥都要填，才能检测接口连接（或者改选「公益中转」）。';
  const setup = await chrome.runtime
    .sendMessage({ type: 'WS_KEY_SETUP', password: pass })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!setup?.ok) return '主密码没能设置：' + (setup?.error || '未知错误');
  const saved = await chrome.runtime
    .sendMessage({ type: 'WS_KEY_SAVE', slot: 'default', key })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));
  if (!saved?.ok) return '密钥没能保存：' + (saved?.error || '未知错误');
  config.vaultSaved = true;
  if ($('w-own-key')) $('w-own-key').value = '';
  if ($('w-own-pass')) $('w-own-pass').value = '';
  return '';
}

// ---------- 引导里直接安装读屏增强组件（2026-11-10 owner 要求） ----------
// 策略与设置页 installNvdaAddon() 一致（那份是逐条加固过的版本，这里只保留同样必要的几条）：
// ① 已有完整下载 → 直接选中复用，不重复下；② 下到一半/暂停 → resume 接着下；
// ③ 中断残片先清掉；④ overwrite 固定文件名（避免 Chrome 生成 (1) 副本）；⑤ 硬超时，绝不挂住。
// 会话 72（2026-11-14）：这里原先还钉在 1.3.0，而设置页与 ADDON/ 分发包早已是 1.3.3
// ⇒ 从引导页装的用户会拿到旧组件。顺势对齐（wennsicht/nvda/ 下确有 1.3.3 文件）。
const NVDA_ADDON_PATH = 'nvda/WennSicht-nvda-bridge-v1.3.3.nvda-addon';
const NVDA_ADDON_NAME = 'WennSicht-nvda-bridge-v1.3.3.nvda-addon';
const ADDON_DL_TIMEOUT = 15000;

// ---------- 会话 72 终版（2026-11-14 15:19 · owner 新方案：先播完，再下载） ----------
// 与设置页同一契约：点按钮当场开始播报，整句念完之后才真正发起下载；
// 下载完成 → chrome.downloads.show(id) 自动打开下载文件夹并选中文件 → 用户按一次回车安装。
// 这样「下载太快把播报抢走」从根上不可能发生：下载动作排在整句念完之后。
// ready / preparing：owner 2026-11-14 15:19 逐字定稿。**仅末句**按 owner 14:39 拍板改为
// 「完成后回到这里点「检查是否已装好」」——引导页没有「检测并优化」按钮，设置页仍是原句。
// ⚠️ 这一句替换是 agent 按 owner 明确选项照做的，其余一字未改。
const NVDA_ADDON_GUIDE = {
  preparing: '正在准备下载。下载完后，文件会自动选中，请按回车打开，根据弹窗导览完成安装并重启NVDA。完成后回到这里点「检查是否已装好」。',
};
// ---------- 会话 76（2026-11-14 19:37 · owner）：第 13 步也能直接做「优化设置」 ----------
// 前提：**检测到读屏增强组件连接成功**（bridgeAlive 返回 ok 且带 settings）。
// 没连上就整块 hidden，不放空按钮、不诱导用户点。
// 会话 77（owner 20:22）：**这里不做复选框**，只给「一键关闭这三项」；
// 三项用纯文字列出（只说明会关什么，不可逐项勾选）——和设置页「检测并优化」是同一个动作。
// 白名单三项与设置页 NVDA_BRIDGE_ITEMS **同一份口径**（标签逐字复用），只动这三项。
const NVDA_OPT_ITEMS = [
  ['autoLanguageSwitching', '语音 → 自动语言切换（若支持）'],
  ['enableMouseTracking', '鼠标 → 启用鼠标导航'],
  ['autoSayAllOnPageLoad', '浏览模式 → 页面加载完成后朗读所有内容'],
];
let nvdaOptBusy = false;

function nvdaBridgeSend(message) {
  try {
    return chrome.runtime.sendMessage(message)
      .catch((e) => ({ ok: false, unreachable: true, error: String(e?.message || e) }));
  } catch (e) {
    return Promise.resolve({ ok: false, unreachable: true, error: String(e?.message || e) });
  }
}

// body 为 null ⇒ 整块隐藏；否则显示，并把按钮状态对齐真实设置（三项都关着就禁用，不让人空点）。
function renderNvdaOptimize(body) {
  const box = $('w-nvda-optimize');
  if (!box) return;
  const settings = body && body.ok ? body.settings : null;
  if (!settings) { box.hidden = true; return; }
  box.hidden = false;
  const btn = $('w-nvda-opt-off');
  if (!btn) return;
  const allOff = NVDA_OPT_ITEMS.every(([key]) => settings[key] === false);
  btn.disabled = allOff;
  btn.textContent = allOff ? '三项已全部关闭' : '一键关闭这三项';
}

// 一键关闭这三项（与设置页「检测并优化」同一行为）：逐项写、终态读回、失败不报成功。
async function optimizeAllNvda() {
  if (nvdaOptBusy) return;
  const st = $('w-nvda-opt-status');
  const btn = $('w-nvda-opt-off');
  const status = await bridgeAlive(1200);
  if (!status?.settings) {
    renderNvdaOptimize(null);
    say('没有连上读屏增强组件，暂时不能优化。装完要重启一次 NVDA。', st);
    return;
  }
  nvdaOptBusy = true;
  if (btn) btn.disabled = true;
  try {
    say('正在优化…', st);
    for (const [key] of NVDA_OPT_ITEMS) {
      if (status.settings[key] !== true) continue;
      const r = await nvdaBridgeSend({ type: 'WS_NVDA_BRIDGE_SET', key, value: false });
      if (!r?.ok) { renderNvdaOptimize(status); say('优化未完成，请重试。', st); return; }
    }
    const final = await bridgeAlive(1200);
    const allOff = final?.settings && NVDA_OPT_ITEMS.every(([key]) => final.settings[key] === false);
    renderNvdaOptimize(final);
    say(allOff ? '已优化完成：三项都关掉了。' : '优化未完成，请重试。', st);
  } finally {
    nvdaOptBusy = false;
  }
}

// 中文 NVDA 默认约 4–5 字/秒 ⇒ 220ms/字 保守估计整句念完时间；下限 4s、上限 18s。
// 仅诊断/回归可由 window.__WS_GUIDE_HOLD_MS__ 覆盖。
function guideHoldMs(text) {
  const override = Number(window.__WS_GUIDE_HOLD_MS__);
  if (Number.isFinite(override) && override >= 0) return override;
  return Math.min(18000, Math.max(4000, String(text).length * 220));
}
// 安装组件阶段机：'idle' | 'announcing' | 'downloading'
let nvdaPhase = 'idle';
let wizardHoldTimer = null;

function restoreWizardLiveRegion() {
  try { const sr = $('wizard-said'); if (sr) sr.setAttribute('aria-live', 'polite'); } catch { /* 忽略 */ }
}
// 把整句念完：写入唯一播报源（say 自带「先清空、60ms 后写入」），窗口结束才 resolve。
// 调用方在此之前**不得发起下载**。
function announceBeforeDownload(text) {
  return new Promise((resolve) => {
    const sr = $('wizard-said');
    try { if (sr) sr.setAttribute('aria-live', 'assertive'); } catch { /* 忽略 */ }
    say(text, $('w-nvda-status'));
    if (wizardHoldTimer) clearTimeout(wizardHoldTimer);
    wizardHoldTimer = setTimeout(() => { wizardHoldTimer = null; resolve(); }, guideHoldMs(text));
  });
}
// 失败说明同样要听得见（不 show()，免得文件夹内容把它顶掉）。
function announceAddonFailure(text) {
  const sr = $('wizard-said');
  try { if (sr) sr.setAttribute('aria-live', 'assertive'); } catch { /* 忽略 */ }
  say(text, $('w-nvda-status'));
  setTimeout(restoreWizardLiveRegion, 15000);
}
// 全页唯一允许抢焦点的地方：只在下载完成之后调用（此时整句早已念完）。
async function showAddonFile(id) {
  restoreWizardLiveRegion();
  try { await chrome.downloads.show(id); } catch { /* 打不开也有文字指路 */ }
  // 自动确认放到打开文件夹之后，避免它的播报抢掉上面那句指引。
  waitForBridge(90000).then((body) => { if (body) reportAddonState(); });
}

// 2026-11-11：安装提示只写**这一刻要做的事**。少数机器上「按回车」会弹系统选择框，那条兜底
// 只在真的检测不到组件时才说（见 ADDON_RETRY_TIP / reportAddonState）；正常用户不该先读一遍故障说明。
const ADDON_RETRY_TIP = '还没有检测到组件。装完要重启一次 NVDA；也可以直接在 NVDA 菜单里装：'
  + '工具 → 附加组件商店 →「从外部来源安装…」。';

function isOwnAddonDownload(d) {
  return d.byExtensionId === chrome.runtime.id
    && /WennSicht-nvda-bridge[^\\/]*\.nvda-addon/i.test(String(d.filename || ''));
}
async function ownAddonDownloads() {
  const all = await chrome.downloads.search({});
  return all.filter(isOwnAddonDownload);
}
function waitAddonDownload(id) {
  return new Promise((resolve) => {
    let settled = false;
    let poll = null;
    let timer = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch { /* 忽略 */ }
      resolve(v);
    };
    const check = async () => {
      try {
        const [d] = await chrome.downloads.search({ id });
        if (!d) return finish({ ok: false, why: 'vanished' });
        if (d.state === 'complete') return finish({ ok: true, id, filename: d.filename });
        if (d.state === 'interrupted') return finish({ ok: false, why: 'interrupted', error: d.error });
        if (d.state === 'paused') await chrome.downloads.resume(id).catch(() => {});
      } catch { /* 忽略瞬时错误 */ }
      return null;
    };
    function onChanged(d) {
      if (d.id === id && d.state?.current && d.state.current !== 'in_progress') check();
    }
    chrome.downloads.onChanged.addListener(onChanged);
    poll = setInterval(check, 350);
    timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), ADDON_DL_TIMEOUT);
    check();
  });
}
// `bridgeAlive()`：直接问一次组件（只读 /status）。用它回答「装没装上」，不靠用户自己猜。
const BRIDGE_STATUS_URL = 'http://127.0.0.1:47653/wennsicht/v1/status';

async function bridgeAlive(timeoutMs) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 1500) : null;
  try {
    const res = await fetch(BRIDGE_STATUS_URL, {
      headers: { 'X-WennSicht-Bridge': '1' },
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body && body.ok ? body : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 装完之后自动确认（最多等 90 秒，每 3 秒问一次）：真的连上才报「已装好」，不让用户猜。
async function waitForBridge(totalMs) {
  const until = Date.now() + (totalMs || 90000);
  while (Date.now() < until) {
    const body = await bridgeAlive(1200);
    if (body) return body;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

// 把「到底装上没有」写成一句人能懂的话：可见文字进 `#w-nvda-status`（该元素**不是** live region），
// 声音只走 `say()` 那一个播报源，所以这句话只会被念一次。
async function reportAddonState() {
  const st = $('w-nvda-status');
  const body = await bridgeAlive();
  // 会话 76：块显隐只反映「组件到底连上没有」，跟播报阶段无关（装的过程中也能看见）。
  renderNvdaOptimize(body);
  // 会话 72：进屏时那次自动检测可能迟到（bridgeAlive 最长 1.5s）；
  // 待确认期间不许它把刚写好的整句指引覆盖掉。
  if (nvdaPhase !== 'idle') return !!body;
  const text = body ? `已经装好了（组件 ${body.bridgeVersion || ''}）。` : ADDON_RETRY_TIP;
  say(text, st);
  return !!body;
}

async function installAddonHere() {
  // 会话 72：播报中 / 下载中再点一次，直接忽略（不重新下载、不重置窗口）。
  if (nvdaPhase !== 'idle') return;

  // ① 先把整句念完 —— 此刻还没有任何下载动作，所以不可能被下载文件夹抢断。
  nvdaPhase = 'announcing';
  await announceBeforeDownload(NVDA_ADDON_GUIDE.preparing);

  // ② 念完之后才真正开始下载。
  nvdaPhase = 'downloading';
  try {
    const existing = (await ownAddonDownloads()).find((d) => d.state === 'complete');
    if (existing) {
      await showAddonFile(existing.id);
      return;
    }
    const running = (await ownAddonDownloads()).find((d) => d.state === 'in_progress' || d.state === 'paused');
    let id = running?.id;
    if (id) {
      if (running.paused) await chrome.downloads.resume(id).catch(() => {});
    } else {
      for (const d of await ownAddonDownloads()) {
        if (d.state === 'interrupted') {
          await chrome.downloads.removeFile(d.id).catch(() => {});
          await chrome.downloads.erase({ id: d.id }).catch(() => {});
        }
      }
      id = await chrome.downloads.download({
        url: chrome.runtime.getURL(NVDA_ADDON_PATH),
        filename: NVDA_ADDON_NAME,
        conflictAction: 'overwrite',
        saveAs: false,
      });
    }
    const r = await waitAddonDownload(id);
    if (!r.ok) {
      // overwrite 被占用时退一步用 uniquify（宁可多一个文件，也不能让用户卡住）
      if (r.why === 'interrupted') {
        await chrome.downloads.erase({ id }).catch(() => {});
        const id2 = await chrome.downloads.download({
          url: chrome.runtime.getURL(NVDA_ADDON_PATH),
          filename: NVDA_ADDON_NAME,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        const r2 = await waitAddonDownload(id2);
        if (!r2.ok) throw new Error(r2.error || r2.why);
        await showAddonFile(id2);
        return;
      }
      throw new Error(r.error || r.why);
    }
    // ③ 下载完成 → 打开下载文件夹并选中文件（用户已听完指引，此时切焦点不会掐断任何播报）
    await showAddonFile(id);
  } catch (err) {
    announceAddonFailure('没能下载安装包：' + String(err?.message || err).slice(0, 70)
      + '。可以稍后到设置页重试，不影响其它功能。');
  } finally {
    nvdaPhase = 'idle';
  }
}
// 2026-11-11 owner：**整页只允许一个播报源**（`#wizard-said`，隐藏的 live region）。
// 之前这里同时写 `#wizard-said` 和 `#wizard-step-status`，而后者也是 `role=status` + `aria-live`
// ⇒ 同一句话被两个活动区域各念一遍。现在可见回显一律**不带 live 语义**，只是给明眼用户看的文字；
// 想让某行可见文字也跟着讲话，就把那个元素作为 visibleEl 传进来（不再另开播报源）。
function say(text, visibleEl) {
  const sr = $('wizard-said');
  const vis = visibleEl || $('wizard-step-status');
  // 会话 76：只有「同一句还要再念一遍」才需要先清空再写（不加这一步读屏不会重复播报）。
  // 换了一句就**立刻写**——旧写法无条件清空，会留下最长 60ms 的空窗：
  // 屏幕上状态行闪空，读屏侧也可能刚好读到空白（会话 76 的回归就踩在这个窗口上）。
  const repeat = !!sr && sr.textContent === text && (!vis || vis.textContent === text);
  if (!repeat) {
    if (sr) sr.textContent = text;
    if (vis) vis.textContent = text;
    return;
  }
  if (sr) sr.textContent = '';
  if (vis) vis.textContent = '';
  setTimeout(() => {
    if (sr) sr.textContent = text;
    if (vis) vis.textContent = text;
  }, 60);
}
function normalizeOrigin(text) {
  try {
    const u = new URL(String(text || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch { return null; }
}
function li(origin, kind) {
  return `<li>${origin} <button type="button" data-remove="${origin}" data-kind="${kind}" aria-label="移除 ${origin}">移除</button></li>`;
}
function renderList(hostId, items, kind, emptyText) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = items.length
    ? items.map((o) => li(o, kind)).join('')
    : `<li>${emptyText}</li>`;
  host.querySelectorAll('button[data-remove]').forEach((b) => {
    b.addEventListener('click', () => removeSite(b.dataset.remove, b.dataset.kind));
  });
}
async function removeSite(origin, kind) {
  if (kind === 'site') {
    delete state.ws_sites[origin];
    delete state.ws_active_sites[origin];
    config.sites = config.sites.filter((o) => o !== origin);
    try { await chrome.scripting.unregisterContentScripts({ ids: [siteScriptId(origin)] }); } catch { /* 未注册则忽略 */ }
    await chrome.storage.local.set({ ws_sites: state.ws_sites, ws_active_sites: state.ws_active_sites });
    renderList('w-site-list', config.sites, 'site', '还没有添加网站（可以留空）。');
  } else if (kind === 'sensitive') {
    delete state.ws_sensitive_sites[origin];
    config.sensitive = config.sensitive.filter((o) => o !== origin);
    await chrome.storage.local.set({ ws_sensitive_sites: state.ws_sensitive_sites });
    renderList('w-sensitive-list', config.sensitive, 'sensitive', '没有额外放行的网站（默认保护生效）。');
  } else if (kind === 'live') {
    delete state.ws_live_sites[origin];
    config.live = config.live.filter((o) => o !== origin);
    await chrome.storage.local.set({ ws_live_sites: state.ws_live_sites });
    renderList('w-live-list', config.live, 'live', '没有开启播报的网站（默认安静）。');
  }
  say(`已移除 ${origin}。`);
}
async function addSiteFrom(inputId, kind) {
  const origin = normalizeOrigin($(inputId)?.value);
  if (!origin) { say('请填完整网址，例如 https://example.com'); return; }
  if (kind === 'site') {
    // 用户手势内第一个异步调用必须是 permissions.request
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    if (!granted) { say('没有授予该网站的权限，未添加。'); return; }
    if (!state.ws_sites[origin]) {
      state.ws_sites[origin] = { addedAt: Date.now() };
      state.ws_active_sites[origin] = true;
      await chrome.storage.local.set({ ws_sites: state.ws_sites, ws_active_sites: state.ws_active_sites });
      try {
        await chrome.scripting.registerContentScripts([{
          id: siteScriptId(origin), matches: [origin + '/*'], js: CFG_FILES,
          runAt: 'document_idle', allFrames: true,
        }]);
      } catch { /* duplicate / 权限不足都不影响列表已保存 */ }
    }
    if (!config.sites.includes(origin)) config.sites.push(origin);
    $(inputId).value = '';
    renderList('w-site-list', config.sites, 'site', '还没有添加网站（可以留空）。');
  } else if (kind === 'sensitive') {
    state.ws_sensitive_sites[origin] = {
      ...(state.ws_sensitive_sites[origin] || {}),
      allowAI: false, forceEnhance: true,
      detectedAt: Date.now(), allowChangedAt: Date.now(), forceChangedAt: Date.now(),
      category: 'user-allowed',
    };
    await chrome.storage.local.set({ ws_sensitive_sites: state.ws_sensitive_sites });
    if (!config.sensitive.includes(origin)) config.sensitive.push(origin);
    config.sensitiveProtect = false;
    const keep = $('w-sensitive-keep'); if (keep) keep.checked = false;
    $(inputId).value = '';
    renderList('w-sensitive-list', config.sensitive, 'sensitive', '没有额外放行的网站（默认保护生效）。');
  } else if (kind === 'live') {
    state.ws_live_sites[origin] = { on: true, at: Date.now(), changedAt: Date.now() };
    await chrome.storage.local.set({ ws_live_sites: state.ws_live_sites });
    if (!config.live.includes(origin)) config.live.push(origin);
    $(inputId).value = '';
    renderList('w-live-list', config.live, 'live', '没有开启播报的网站（默认安静）。');
  }
  say(`已保存：${origin}。`);
}
async function applyGlobal(on) {
  if (on) {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) return false;
    try {
      await chrome.scripting.registerContentScripts([{
        id: GLOBAL_SCRIPT_ID, matches: ['<all_urls>'], js: CFG_FILES,
        runAt: 'document_idle', allFrames: true,
      }]);
    } catch (err) {
      if (!/duplicate/i.test(String(err?.message || err))) throw err;
    }
  } else {
    try { await chrome.scripting.unregisterContentScripts({ ids: [GLOBAL_SCRIPT_ID] }); } catch { /* 未注册 */ }
  }
  await chrome.storage.local.set({ ws_global: on });
  return true;
}

// ---------- 示例网页（内嵌，离线，无网络请求） ----------
const DEMO_SRCDOC = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; font-size: 15px;
         line-height: 1.7; margin: 0; padding: 14px 18px; color: #1c2433; background: #fffdf5; }
  h2 { font-size: 1.1em; margin: .5em 0 .2em; }
  p { margin: .3em 0; }
  .promo { background: #ffe8e8; padding: .3em .6em; border: 1px dashed #c66; }
  .ph { display: inline-block; border: 2px dashed #999; padding: .5em 1em; margin: .3em 0; }
  table { border-collapse: collapse; } td, th { border: 1px solid #aaa; padding: .15em .5em; }
  .ws-mark { background: #fff2a8; outline: 2px solid #d59b00; }
  .ws-hidden { display: none; }
  .ws-badge { font-size: .8em; color: #8a4b00; font-weight: 700; }
</style></head><body>
  <div class="promo" id="promo">限时优惠！点这里领券（演示用的浮层广告）</div>
  <h2 id="h1">第一节：怎么开始</h2>
  <p id="p1">这一段讲第一次打开网站时会发生什么。读屏按 H 可以直接跳到各个标题。</p>
  <div class="ph" id="img">［示例图片：一张没有说明的图］</div>
  <h2 id="h2">第二节：主要内容</h2>
  <p id="p2">这一段是示例网页的正文。页面问答可以问「第 2 块讲什么」，会按这一块回答。</p>
  <table id="tbl"><tr><th>项目</th><th>数量</th></tr><tr><td>示例</td><td>3</td></tr></table>
  <h2 id="h3">第三节：怎么结束</h2>
  <p id="p3">这一段讲收尾。布局地图会告诉你哪几块值得读、哪几块可以跳过。</p>
</body></html>`;

function demoDoc() {
  try { return $('demo-frame').contentDocument; } catch { return null; }
}
function clearMarks() {
  const d = demoDoc(); if (!d) return;
  d.querySelectorAll('.ws-mark, .ws-badge').forEach((e) => {
    if (e.classList.contains('ws-badge')) e.remove();
    else e.classList.remove('ws-mark');
  });
}
function mark(ids) {
  clearMarks();
  const d = demoDoc(); if (!d) return;
  for (const id of ids) {
    const el = d.getElementById(id);
    if (el) el.classList.add('ws-mark');
  }
}
function badge(text) {
  const d = demoDoc(); if (!d) return;
  const p = d.createElement('p');
  p.className = 'ws-badge';
  p.textContent = text;
  d.body.appendChild(p);
}

const DEMO_ACTIONS = [
  {
    id: 'toggle', label: '试：开启 / 关闭增强', cmd: 'toggle-wennsicht',
    run: (on) => {
      const d = demoDoc();
      if (d) {
        const promo = d.getElementById('promo');
        if (promo) promo.classList.toggle('ws-hidden', !!on);
      }
      say(on ? '无障碍增强已开启：补出 3 个标题、补出 2 个区块地标、隐藏 1 个推广浮层。'
        : '无障碍增强已关闭，页面已恢复原状。');
      badge(on ? '（演示）浮层已被隐藏，标题层级已补好' : '（演示）页面恢复成原样');
      return !on;
    },
  },
  {
    id: 'summary', label: '试：页面结构摘要', cmd: 'page-summary',
    run: () => { mark(['h1', 'h2', 'h3']); say('页面摘要：本页共 3 节，依次是「怎么开始」「主要内容」「怎么结束」。先给结论：这是一张用来演示按键效果的示例网页。'); badge('（演示）摘要会抓住标题大纲'); },
  },
  {
    id: 'map', label: '试：布局地图', cmd: 'layout-map',
    run: () => { mark(['h1', 'h2', 'h3']); say('本页共 3 块内容，其中值得读 3 块。你现在大约在第 1 块「怎么开始」附近（位置为估计）。再按一次继续听后面的块。'); badge('（演示）地图会标出哪几块值得读'); },
  },
  {
    id: 'qa', label: '试：页面问答', cmd: 'page-qa',
    run: () => { mark(['h2', 'p2']); say('问：第 2 块讲什么？答：第 2 块「主要内容」讲的是示例网页的正文，并附了一张表格。'); badge('（演示）问答会按你点名的块回答'); },
  },
  {
    id: 'longdesc', label: '试：图片长描述', cmd: 'image-longdesc',
    run: () => { mark(['img']); say('图片长描述：这是一张演示用的占位图，图中没有文字。真实网页里会读出图片的画面内容和图里的文字。'); badge('（演示）长描述会读图里的内容'); },
  },
  {
    id: 'feedback', label: '试：一键反馈', cmd: 'send-feedback',
    run: () => { clearMarks(); say('反馈窗口已打开，写一句话就能发给我们。这里是演示，不会真的发送任何内容。'); badge('（演示）反馈窗口，仅演示不发送'); },
  },
];

// ---------- 快捷键（第 12 步）：跟用户实际绑定走，改完切回来就自动更新 ----------
// 会话 79（owner）：用户在这一步点按钮跳去 chrome://extensions/shortcuts 改键，
// 回到本页时旧实现不会重读（只有刷新才行，而刷新会回到引导第一步）⇒
// 现在监听「标签页重新可见 / 窗口重新获得焦点」自动重读并**原地更新列表**（不整屏重绘）。
const SHORTCUT_LABELS = {
  'toggle-wennsicht': '开启 / 关闭增强', 'pause-image-description': '暂停图片描述',
  'send-feedback': '一键反馈', 'page-summary': '页面结构摘要', 'page-qa': '页面问答',
  'image-longdesc': '图片长描述', 'layout-map': '布局地图', '_execute_action': '打开扩展设置',
};
function shortcutListHtml(list) {
  return (list || []).map((c) => {
    const label = SHORTCUT_LABELS[c.name] || c.description || c.name;
    return `<li><strong>${label}</strong>：${c.shortcut ? c.shortcut : '<strong>未绑定，需要到设置页分配一个按键</strong>'}</li>`;
  }).join('');
}
function shortcutSummaryHtml(list) {
  const unbound = (list || []).filter((c) => !c.shortcut).length;
  return `<strong>要特别注意：</strong>${unbound ? `还有 ${unbound} 项没有按键，按了不会有任何反应。` : '目前每一项都有按键。'}
    ${unbound ? '页面问答、布局地图、图片长描述默认就没有分配按键，需要到 Chrome 的快捷键页面分配。'
      : '换一台电脑重装时，页面问答、布局地图、图片长描述默认仍没有按键，记得先分配。'}`;
}
function shortcutSnapshot(list) {
  return (list || []).map((c) => `${c.name}=${c.shortcut || ''}`).join('|');
}
async function readShortcuts() {
  try { commands = await chrome.commands.getAll(); } catch { commands = []; }
  setToggleKey(commands);
  return commands;
}
// 不在这一屏时也更新 commands：演示页与末页都取它。
async function refreshShortcuts() {
  const before = shortcutSnapshot(commands);
  await readShortcuts();
  const list = $('w-shortcuts-list');
  const summary = $('w-shortcuts-summary');
  if (!list || !summary) return;
  list.innerHTML = shortcutListHtml(commands);
  summary.innerHTML = shortcutSummaryHtml(commands);
  if (shortcutSnapshot(commands) !== before) say('键盘快捷键已更新。');
}
function bindShortcutRefresh() {
  if (bindShortcutRefresh.done) return;
  bindShortcutRefresh.done = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshShortcuts();
  });
  window.addEventListener('focus', () => { refreshShortcuts(); });
}

// 第 7 屏「使用自己的接口」的必填项清单：按钮态（wire）与放行判定（guard）共用这一份。
// 之前两处各写一份字段表，2026-11-15 把决策模型改成必填时就漏掉了 guard 那份——
// 于是按钮说「还差…」，放行检查里却仍写着「决策模型可以空着」。
function missingOwnFields() {
  // 优先读**输入框当前值**：config.own 只在 change（失焦）时同步，用户「填完立刻点下一步」
  // 或刚清空某一格时，内存里可能还是旧值 —— 直接读 DOM 才能与用户眼前所见一致。
  // 不在这一屏时（DOM 不存在）回落到 config.own。
  const val = (id, key) => String($(id)?.value ?? config.own?.[key] ?? '').trim();
  const miss = [
    [val('w-own-base', 'baseUrl'), '接口地址'],
    [val('w-own-text', 'textModel'), '文本模型'],
    [val('w-own-vision', 'visionModel'), '视觉模型'],
    [val('w-own-decision', 'decisionModel'), '决策模型'], // 2026-11-15 owner 定案：与其他模型同口径必填
  ].filter(([v]) => !v).map(([, label]) => label);
  if (config.vaultSaved !== true) {
    if (!$('w-own-key')?.value.trim()) miss.push('接口密钥');
    if (!$('w-own-pass')?.value.trim()) miss.push('主密码');
  }
  return miss;
}

// ---------- 11 项设置：每项一屏，屏上就是真控件 ----------
// body() 可返回字符串/Promise<string>；wire() 渲染后挂事件；guard() 返回字符串则不许翻页。
const STEPS = [
  {
    id: 'intro', title: '欢迎使用 循光WennSicht',
    body: () => `
      <p>这个扩展会把网页里读屏念不清楚的地方补好，再加几个能问、能听摘要的按键。</p>
      <p>下面把设置页里的 ${TOTAL_SETTINGS} 项设置一项一项摆在你面前，<strong>每一项都能当场改</strong>，
      改完立刻保存。走完这一遍，<strong>所有设置就都配置好了</strong>，不用再记着去别处补做什么。</p>
      <p class="hint">第 7 项如果选「使用自己的接口」，会多出几个填写框（地址 / 模型 / 密钥 / 主密码）和一次连接检测；选公益中转则完全不用填。</p>
      <p>后面还有一张<strong>内嵌的示例网页</strong>，可以亲手试每个按键大概会说什么。</p>
      <p class="hint">全程只用键盘：Tab 走到控件、空格勾选、回车确认。随时可以点「上一项」回去改。</p>`,
    next: '开始',
  },
  {
    id: 'global', title: '设置 1：全局启用', setting: 1,
    body: () => `
      <p><strong>这项做什么：</strong>打开后，所有网站一打开就自动开启增强，不用逐个添加站点。</p>
      <p><strong>关着会怎样：</strong>只有在你添加过的站点、或你亲自按 ${TOGGLE_KEY} 的那一页才生效。</p>
      <p class="row"><label><input type="checkbox" id="w-global" ${config.global ? 'checked' : ''}> 开启全局启用</label></p>
      <p class="hint">打开时浏览器可能问你是否允许访问所有网站；不改它就保持现在的状态，不会弹框。改完立即保存。</p>`,
    wire: () => {
      $('w-global').addEventListener('change', async (e) => {
        const want = e.target.checked;
        try {
          const ok = await applyGlobal(want);
          if (!ok) { e.target.checked = config.global; say('没有授予全站权限，保持关闭。'); return; }
          config.global = want;
          say(want ? '已保存：全局启用已开启。' : '已保存：全局启用已关闭。');
        } catch (err) {
          e.target.checked = config.global;
          say('没能保存：' + String(err?.message || err));
        }
      });
    },
  },
  {
    id: 'sites', title: '设置 2：添加站点', setting: 2,
    // 2026-11-10 owner：如果**第 1 步已经把全局启用打开**（或用户是从设置页重走引导、本来
    // 就开着全局），逐个添加站点就完全多余了 —— 这时**不再重复解释这项设置是干什么的**，
    // 只明确告诉用户「检测到已开启全局启用，这一步可以跳过」，然后直接翻页。
    // 判定读 `config.global` 的实时值：用户回退到第 1 步把全局关掉，再进来又会看到原来的表单。
    body: () => (config.global
      ? `<p class="notice" id="w-sites-skip"><strong>检测到你已经开启全局启用：所有网站打开时都会自动开启增强，不用再逐个添加，这一步可以直接跳过。</strong></p>`
      : `
      <p><strong>这项做什么：</strong>把常用的网站加进来，以后打开这些网站就自动开启增强。</p>
      <p><strong>不添加会怎样：</strong>照样能用，只是每次要自己按 ${TOGGLE_KEY}；留空也是一项有效配置。</p>
      <p class="row"><label for="w-site-input">添加网站：</label>
        <input type="text" id="w-site-input" placeholder="https://example.com" autocomplete="off" spellcheck="false">
        <button type="button" id="w-site-add">添加并保存</button></p>
      <ul id="w-site-list"></ul>`),
    wire: () => {
      // 跳过态没有任何控件可接（也不该在这里偷偷改配置）
      if (config.global) return;
      renderList('w-site-list', config.sites, 'site', '还没有添加网站（留空即可）。');
      $('w-site-add').addEventListener('click', () => addSiteFrom('w-site-input', 'site'));
      $('w-site-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addSiteFrom('w-site-input', 'site'); }
      });
    },
  },
  {
    id: 'sensitive', title: '设置 3：敏感站点保护', setting: 3,
    body: () => `
      <p><strong>这项做什么：</strong>银行、支付、浏览器内部页面等一律不处理，也不会把内容送去任何模型；就算开了全局启用也一样拦住。</p>
      <p><strong>为什么：</strong>这些页面涉及钱和隐私，宁可不增强，也不能把页面内容带出去。</p>
      <p class="row"><label><input type="checkbox" id="w-sensitive-keep" ${config.sensitiveProtect ? 'checked' : ''}> 保持默认保护，不额外放行任何网站（推荐）</label></p>
      <p class="row"><label for="w-sensitive-input">确实要给某个网站放行：</label>
        <input type="text" id="w-sensitive-input" placeholder="https://example.com" autocomplete="off" spellcheck="false" aria-describedby="w-sensitive-hint">
        <button type="button" id="w-sensitive-add" aria-describedby="w-sensitive-hint">放行并保存</button></p>
      <p class="hint" id="w-sensitive-hint"></p>
      <ul id="w-sensitive-list"></ul>`,
    wire: () => {
      const keep = $('w-sensitive-keep');
      const input = $('w-sensitive-input');
      const addBtn = $('w-sensitive-add');
      const hint = $('w-sensitive-hint');
      // 2026-11-10 owner：**只有取消勾选「保持默认保护」之后才允许放行站点**。
      // 勾着「保持默认保护」却还能填站点，语义自相矛盾（等于一边说全保护、一边开洞），
      // 所以直接把输入框和按钮禁用，并在下面说清「先取消勾选」。
      const sync = () => {
        const blocked = config.sensitiveProtect === true;
        input.disabled = blocked;
        addBtn.disabled = blocked;
        if (blocked) {
          hint.textContent = '当前勾选了「保持默认保护」。要给某个网站放行，请先取消上面的勾选。';
        } else if (config.sensitive.length === 0) {
          hint.textContent = '现在可以添加要放行的网站；若不想放行任何网站，请把上面的「保持默认保护」重新勾上，否则不能翻到下一步。';
        } else {
          hint.textContent = '已放行的网站列在下面；点网站后面的「移除」可以撤销放行。';
        }
      };
      renderList('w-sensitive-list', config.sensitive, 'sensitive', '没有额外放行的网站（默认保护生效）。');
      sync();
      // 列表被添加/移除后（renderList 会重建 innerHTML），提示语跟着更新
      try { new MutationObserver(sync).observe($('w-sensitive-list'), { childList: true }); } catch { /* 老浏览器忽略 */ }
      addBtn.addEventListener('click', async () => {
        if (addBtn.disabled) return;
        await addSiteFrom('w-sensitive-input', 'sensitive');
        sync();
      });
      keep.addEventListener('change', async (e) => {
        config.sensitiveProtect = e.target.checked;
        if (e.target.checked) {
          for (const o of config.sensitive.slice()) await removeSite(o, 'sensitive');
          await chrome.storage.local.set({ ws_sensitive_sites: {} });
          state.ws_sensitive_sites = {};
          say('已保存：保持默认保护，没有额外放行的网站。');
        }
        sync();
      });
    },
    // 「取消勾选」= 明确表示要放行个别网站 ⇒ 必须真的放行至少一个；
    // 既不放行、又不勾保护，等于给了一个自相矛盾的配置，不许翻页。
    guard: () => {
      if (config.sensitiveProtect === true) return '';
      if (config.sensitive.length > 0) return '';
      return '这一步还没配好：要么在下面添加要放行的网站，要么把「保持默认保护」重新勾上。';
    },
  },
  {
    id: 'ai-master', title: '设置 4：智能功能总开关', setting: 4,
    body: () => `
      <p><strong>这项做什么：</strong>控制场景解析、图片描述、页面问答、摘要、图表说明、链接意图补充这些需要调用大模型的功能。</p>
      <p><strong>关着会怎样：</strong>上面这些功能就用不了，按了也只会提示「功能不可用」。标题层级、地标、表单提示、结构地图、推广浮层隐藏这些基础功能照常工作，代价是判断会变粗：没有作者写说明的图片只能告诉你「这张没有说明」，复杂网站上有些判断（比如某个「点击这里」通向哪里、某块是不是推广浮层）会直接不做。</p>
      <p class="row"><label><input type="checkbox" id="w-ai-master" ${config.aiEnabled ? 'checked' : ''}> 开启智能功能${config.aiEnabled ? '（推荐）' : ''}</label></p>`,
    wire: () => {
      $('w-ai-master').addEventListener('change', async (e) => {
        config.aiEnabled = e.target.checked;
        await mergeWrite('ws_ai_config', { enabled: e.target.checked });
        say(e.target.checked ? '已保存：智能功能已开启。' : '已保存：智能功能已关闭。');
      });
    },
  },
  {
    id: 'img-limit', title: '设置 5：每天图片描述上限', setting: 5,
    // 2026-11-10 owner：原来只能靠「填 0」表达不设上限，结果摘要还会说「上限 0 张」，
    // 看起来像「一次都不给」。改为**先用复选框明确「要不要设上限」**：
    // 不勾 = 不设上限（输入框禁用）；勾了才填数字，留空报错，填 0 就是真的每天 0 次。
    body: () => `
      <p><strong>这项做什么：</strong>智能功能的图片描述是按天计数的。这里决定要不要设一个每日上限，防止不知不觉用掉太多额度。</p>
      <p class="row"><label><input type="checkbox" id="w-limit-on" ${config.limitEnabled ? 'checked' : ''}> 限制每天最多描述多少张图片</label></p>
      <p class="row"><label for="w-limit">每天上限：</label>
        <input type="number" id="w-limit" min="0" step="1" value="${config.dailyLimit}" aria-describedby="w-limit-hint"> 张</p>
      <p class="hint" id="w-limit-hint"></p>`,
    wire: () => {
      const on = $('w-limit-on');
      const num = $('w-limit');
      const hint = $('w-limit-hint');
      const sync = () => {
        num.disabled = config.limitEnabled !== true;
        hint.textContent = config.limitEnabled
          ? '达到上限后剩下的图片只按本地词典提示，第二天自动恢复。填 0 表示一天都不生成图片描述。'
          : '不设上限：当天有多少张缺说明的图片就描述多少张，第二天重新计。';
      };
      sync();
      on.addEventListener('change', async (e) => {
        config.limitEnabled = e.target.checked;
        await mergeWrite('ws_image_config', { limitEnabled: config.limitEnabled });
        sync();
        say(config.limitEnabled
          ? `已保存：开启每日上限，当前是每天最多 ${config.dailyLimit} 张。`
          : '已保存：不设每日上限。');
      });
      num.addEventListener('change', async (e) => {
        const raw = e.target.value.trim();
        // 留空：不写盘，交给 guard 提示「勾了上限却没填数字」
        if (raw === '') { config.dailyLimit = null; return; }
        const n = Math.max(0, Math.round(Number(raw) || 0));
        e.target.value = String(n);
        config.dailyLimit = n;
        await mergeWrite('ws_image_config', { dailyLimit: n });
        say(n === 0
          ? '已保存：每天最多 0 张，也就是不再生成图片描述。'
          : `已保存：每天最多 ${n} 张图片描述。`);
      });
    },
    guard: () => {
      if (config.limitEnabled !== true) return '';
      const n = config.dailyLimit;
      if (n === null || n === undefined || !Number.isFinite(Number(n))) {
        return '已经勾选「限制每天最多描述多少张图片」，但还没填数字：请填一个 0 或正整数（0 表示一天都不生成描述），或者取消勾选表示不设上限。';
      }
      return '';
    },
  },
  {
    id: 'hover', title: '设置 6：悬停重听', setting: 6,
    body: () => `
      <p><strong>这项做什么：</strong>指针停在图片上约 1 秒，就重念一次这张图的描述。</p>
      <p><strong>适合谁：</strong><strong>只建议低视力 / 非全盲用户开启。</strong></p>
      <p>如果您是全盲用户，建议关闭此功能，防止鼠标移动意外触发播报。</p>
      <p class="row"><label><input type="checkbox" id="w-hover" ${config.hoverReplay ? 'checked' : ''}> 开启悬停重听</label></p>`,
    wire: () => {
      $('w-hover').addEventListener('change', async (e) => {
        config.hoverReplay = e.target.checked;
        await mergeWrite('ws_image_config', { hoverReplay: e.target.checked });
        say(e.target.checked ? '已保存：悬停重听已开启。' : '已保存：悬停重听已关闭。');
      });
    },
  },
  {
    id: 'provider', title: '设置 7：大模型接口', setting: 7,
    body: () => `
      <p><strong>这项做什么：</strong>决定智能功能把请求发给谁。选「公益中转」就是<strong>完整配置好了</strong>：不用申请接口、不用填密钥，开箱即用。</p>
      <p>稍后也可在设置页面添加备用模型。</p>
      <p class="row"><label><input type="radio" name="w-provider" value="relay" ${config.provider === 'relay' ? 'checked' : ''}> 使用官方公益中转（推荐）</label></p>
      <p class="row"><label><input type="radio" name="w-provider" value="own" ${config.provider === 'own' ? 'checked' : ''}> 使用自己的接口</label></p>
      <div id="w-own-fields" ${config.provider === 'own' ? '' : 'hidden'}>
        <p><label>接口地址 <input type="text" id="w-own-base" value="${config.own.baseUrl}"></label></p>
        <p><label>文本模型 <input type="text" id="w-own-text" value="${config.own.textModel}"></label></p>
        <p><label>视觉模型 <input type="text" id="w-own-vision" value="${config.own.visionModel}"></label></p>
        <p><label>决策模型 <input type="text" id="w-own-decision" value="${config.own.decisionModel}"></label></p>
        <p><label>接口密钥（API Key） <input type="password" id="w-own-key" autocomplete="off"></label></p>
        <p><label>主密码（用来加密密钥） <input type="password" id="w-own-pass" autocomplete="new-password"></label></p>
        <p class="hint">密钥用主密码加密后只存在本机，不上传、也找不回主密码，请自己记住。所有框要么都填、要么都不填。</p>
      </div>`,
    // 2026-11-10 owner：主密码并进这一屏（不再单独一页）。填全了按钮变「检测接口连接，然后下一项」，
    // 第一次按真的去 ping 一次接口；公益中转则完全不出现这些字段，按钮还是「下一项」。
    next: () => (config.provider === 'own' ? '检测接口连接，然后下一项' : '下一项'),
    wire: () => {
      const secretIds = ['w-own-key', 'w-own-pass'];
      const missing = () => missingOwnFields(); // 必填清单见模块级 missingOwnFields()（与 guard 共用）
      const persist = async (announceIfComplete) => {
        const ai = {
          provider: config.provider === 'own' ? 'openai-compatible' : 'builtin-relay',
        };
        if (config.provider === 'own') {
          const cur = await obj('ws_ai_config');
          ai.default = {
            ...(cur.default || {}),
            baseUrl: config.own.baseUrl,
            textModel: config.own.textModel,
            visionModel: config.own.visionModel,
            decisionModel: config.own.decisionModel,
          };
        }
        await mergeWrite('ws_ai_config', ai);
        if (config.provider === 'relay') {
          say('已保存：使用官方公益中转，无需任何密钥。');
        } else if (announceIfComplete && missing().length === 0) {
          // 只有**整屏填完整**才说「已写入」；刚点一下「使用自己的接口」不报这句话
          say('已保存：接口地址、模型名、密钥与主密码都已记录。');
        }
      };
      const syncNextLabel = () => {
        const cur = STEPS[idx];
        const btn = $('wizard-next');
        if (btn && cur?.next) btn.textContent = typeof cur.next === 'function' ? cur.next() : cur.next;
      };
      // 重走引导时：本机已经存过 default 档密钥 ⇒ 不必逼用户重填主密码/密钥
      chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' })
        .then((st) => { if (st?.default) { config.vaultSaved = true; syncNextLabel(); } })
        .catch(() => {});
      document.querySelectorAll('input[name="w-provider"]').forEach((r) => {
        r.addEventListener('change', async () => {
          config.provider = r.value;
          $('w-own-fields').hidden = config.provider !== 'own';
          syncNextLabel();
          await persist(false);
          if (config.provider === 'own') {
            say('使用自己的接口：把接口地址、模型名、密钥、主密码都填上，再点「检测接口连接，然后下一项」。');
          }
        });
      });
      const fields = { 'w-own-base': 'baseUrl', 'w-own-text': 'textModel', 'w-own-vision': 'visionModel', 'w-own-decision': 'decisionModel' };
      for (const [id2, key] of Object.entries(fields)) {
        $(id2)?.addEventListener('change', async (e) => {
          config.own[key] = e.target.value.trim();
          config.ownTestFailed = false; // 改了接口/模型 ⇒ 之前那次失败作废，下次要重测
          await persist(true); // 填完整才播「已写入」；填一半保持安静
        });
      }
      for (const id2 of secretIds) {
        $(id2)?.addEventListener('input', () => {
          config.vaultSaved = false;   // 改了密钥/主密码，就得重新加密保存
          config.ownTestFailed = false;
        });
      }
    },
    // 三种结局：① 没填全 → 报错不许走；② 测通 → 进下一项；
    // ③ 填全了但接口连不上 → 只报「未通过 + 怎么办」，**再按一次就放行**（不把人锁死）。
    // ⚠️ 文案只给用户可执行的信息；原始报错进 console.warn，不念给用户听（owner 19:29）。
    guard: async () => {
      if (config.provider !== 'own') return '';
      const miss = missingOwnFields();
      if (miss.length) return `还差：${miss.join('、')}。要填必须都填；或者改选「公益中转」。`;
      say('正在检测接口连接…');
      const err = await ensureVaultSaved();
      if (err) return err;
      if (config.ownTestFailed) return '';
      const res = await chrome.runtime
        .sendMessage({ type: 'WS_AI_VERIFY' })
        .catch((e) => ({ error: String(e?.message || e) }));
      if (res?.defaultVision?.ok || res?.defaultText?.ok) {
        say('接口连接检测通过，已保存。');
        return '';
      }
      // 原始错误只留在控制台供排查，**不进用户播报**（owner 19:29：不许把内部沟通口径说给用户）。
      const why = res?.defaultVision?.error || res?.defaultText?.error || res?.error || '没有返回可用结果';
      try { console.warn('[WennSicht] 接口连接检测失败：', why); } catch { /* 忽略 */ }
      config.ownTestFailed = true;
      return '接口连接检测未通过：请修改相关配置或检查节点是否正常。也可忽略检测结果直接下一页。';
    },
  },
  {
    id: 'announce', title: '设置 8：播报增强做了什么', setting: 8,
    body: () => `
      <p><strong>这项做什么：</strong>开启增强时念一句「修复了几个标题、补出了几个地标」这类统计。</p>
      <p><strong>关着会怎样：</strong>只说一句「无障碍增强已开启」，更安静；错误提示始终会念。</p>
      <p class="row"><label><input type="checkbox" id="w-announce" ${config.announceChanges ? 'checked' : ''}> 开启明细播报${config.announceChanges ? '（推荐）' : ''}</label></p>`,
    wire: () => {
      $('w-announce').addEventListener('change', async (e) => {
        config.announceChanges = e.target.checked;
        await mergeWrite('ws_ui_config', { announceChanges: e.target.checked });
        say(e.target.checked ? '已保存：开启时会播报优化内容。' : '已保存：开启时默认静默。');
      });
    },
  },
  {
    id: 'position', title: '设置 9：记住并恢复上次浏览位置', setting: 9,
    body: () => `
      <p><strong>这项做什么：</strong>刷新或后退回来时，自动回到你上次读到的地方，并把焦点放到那一节的标题上。</p>
      <p><strong>关着会怎样：</strong>刷新后回到页首。</p>
      <p class="row"><label><input type="checkbox" id="w-position" ${config.positionMemory ? 'checked' : ''}> 记住并恢复位置${config.positionMemory ? '（推荐）' : ''}</label></p>`,
    wire: () => {
      $('w-position').addEventListener('change', async (e) => {
        config.positionMemory = e.target.checked;
        await mergeWrite('ws_ui_config', { positionMemory: e.target.checked });
        say(e.target.checked ? '已保存：刷新后回到上次的位置。' : '已保存：刷新后回到页首或使用屏幕阅读器自带记忆功能。');
      });
    },
  },
  {
    id: 'live', title: '设置 10：动态变化播报', setting: 10,
    body: () => `
      <p><strong>这项做什么：</strong>给指定的网站开启后，页面自己更新了内容会念一句提醒。</p>
      <p><strong>默认安静：</strong>它是按网站开的；留空就是一项有效配置，不会每个页面都吵。</p>
      <p class="row"><label for="w-live-input">给哪个网站开启：</label>
        <input type="text" id="w-live-input" placeholder="https://example.com" autocomplete="off" spellcheck="false">
        <button type="button" id="w-live-add">开启并保存</button></p>
      <ul id="w-live-list"></ul>`,
    wire: () => {
      renderList('w-live-list', config.live, 'live', '没有开启播报的网站（留空即可）。');
      $('w-live-add').addEventListener('click', () => addSiteFrom('w-live-input', 'live'));
      $('w-live-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addSiteFrom('w-live-input', 'live'); }
      });
    },
  },
  {
    id: 'shortcuts', title: '再看一遍：键盘快捷键',
    body: async () => {
      await readShortcuts();
      if (!commands.length) return '<p>没能读到快捷键列表，请到设置页「键盘快捷键」里查看。</p>';
      return `
        <p>设置已经全部保存好了。这个扩展的功能大多靠按键触发，下面是<strong>你电脑上真实的绑定情况</strong>。</p>
        <ul id="w-shortcuts-list">${shortcutListHtml(commands)}</ul>
        <p id="w-shortcuts-summary">${shortcutSummaryHtml(commands)}</p>
        <p class="row"><button type="button" id="w-shortcuts-open">打开 Chrome 的快捷键设置页</button></p>
        <p class="hint">下面一页有一张示例网页，可以先听一遍每个功能大概会说什么。</p>`;
    },
    // 2026-11-10 owner：这里直接给一个入口，省得用户自己找 chrome://extensions/shortcuts
    // 会话 79：改完键切回本页会自动重读并更新列表，不需要刷新（刷新会回到第一步）。
    wire: () => {
      $('w-shortcuts-open')?.addEventListener('click', async () => {
        try {
          await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
          say('已在新的标签页打开快捷键设置页，设置完成回到本页面继续。');
        } catch {
          say('打开失败。请在新标签页地址栏输入 chrome://extensions/shortcuts 再回车。');
        }
      });
      bindShortcutRefresh();
    },
  },
  {
    id: 'nvda', title: '如果你用 NVDA：两项可选优化',
    body: () => `
      <p>这两项都<strong>不是必须的</strong>，不装任何东西也能用前面全部功能；它们不影响刚才已经保存的 ${TOTAL_SETTINGS} 项设置。</p>
      <p><strong>① 让朗读更顺：</strong>检测到组件连上以后，下面会直接列出三项会干扰朗读的设置，可以逐个开关，也可以一键全关；设置页「一、开始使用 → 让 NVDA 读得更顺 → 检测并优化」是同一件事。</p>
      <p><strong>② 精确报出你读到哪一节：</strong>可选装一次读屏增强组件。装了以后问「我在哪一节」能精确报出节名；<strong>不装也能问</strong>，只是答案明确标注「位置为估计」并给附近几节让你点名纠正。</p>
      <p class="row"><button type="button" id="w-nvda-install">下载读屏增强组件（可选）</button>
        <button type="button" id="w-nvda-check">检查是否已装好</button></p>
      <p class="row-status" id="w-nvda-status"></p>
      <p class="hint">点按钮下载后，会自动打开下载文件夹并选中安装包；按回车打开，根据弹窗导览完成安装并重启 NVDA。点「检查是否已装好」按钮确认是否安装成功。</p>
      <div id="w-nvda-optimize" hidden>
        <p>已检测到读屏增强组件连接成功。下面这三项会干扰朗读，<strong>改的是 NVDA 自己的设置，只动这三项</strong>：</p>
        <ul class="opt-list" id="w-nvda-opt-list">
          <li>语音 → 自动语言切换（若支持）</li>
          <li>鼠标 → 启用鼠标导航</li>
          <li>浏览模式 → 页面加载完成后朗读所有内容</li>
        </ul>
        <p class="row"><button type="button" id="w-nvda-opt-off">一键关闭这三项</button></p>
        <p class="row-status" id="w-nvda-opt-status"></p>
      </div>`,
    // 2026-11-10 owner：允许在引导里直接装好，不用再跳去设置页
    wire: () => {
      $('w-nvda-install')?.addEventListener('click', () => { installAddonHere(); });
      // 进这一屏就先把真实状态说出来（已装好 / 还没检测到），点按钮再复核一次
      $('w-nvda-check')?.addEventListener('click', () => { reportAddonState(); });
      $('w-nvda-opt-off')?.addEventListener('click', () => { optimizeAllNvda(); });
      reportAddonState();
    },
  },
  {
    id: 'demo', title: '在示例网页里试一遍',
    body: () => `
      <p>下面是一张<strong>内嵌的示例网页</strong>。点按钮会听到这个功能大概会念什么，示例网页里也会标出它作用在哪些内容上。</p>
      <p class="hint"><strong>这是演示，不会真的联网、不会调用模型、也不会发送反馈。</strong>真正在网页里用，请按上一页列出的对应按键。</p>
      <div class="demo-buttons" id="demo-buttons"></div>
      <p id="demo-shortcuts" class="hint"></p>`,
    wire: () => {
      const host = $('demo-buttons');
      let enhanced = false;
      for (const a of DEMO_ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        b.dataset.demoId = a.id;
        b.addEventListener('click', () => {
          const ret = a.run(enhanced);
          if (a.id === 'toggle') enhanced = !!ret;
          const c = commands.find((x) => x.name === a.cmd);
          $('demo-shortcuts').textContent = c
            ? `「${a.label.replace(/^试：/, '')}」在真实网页里按：${c.shortcut || '尚未分配按键，请到设置页分配'}`
            : '';
        });
        host.appendChild(b);
      }
      $('demo-shortcuts').textContent = '点上面的按钮开始演示。';
    },
    showDemo: true,
  },
  {
    id: 'finish', title: '都设置好了，可以开始用了',
    body: () => {
      const rows = [
        `全局启用：${config.global ? '开启' : '关闭'}`,
        `常用站点：${config.sites.length ? config.sites.join('、') : '不添加'}`,
        `敏感站点保护：${config.sensitiveProtect ? '保持默认保护' : `额外放行 ${config.sensitive.length} 个网站`}`,
        `智能功能：${config.aiEnabled ? '开启' : '关闭'}`,
        `每天图片描述上限：${config.limitEnabled !== true
          ? '不设上限'
          : (config.dailyLimit === 0 ? '0 张（不生成图片描述）' : `${config.dailyLimit} 张`)}`,
        `悬停重听：${config.hoverReplay ? '开启' : '关闭'}`,
        `大模型接口：${config.provider === 'relay' ? '官方公益中转' : '自己的接口'}`,
        `接口密钥：${config.provider === 'relay'
          ? '不需要（公益中转）'
          : (config.vaultSaved ? '已加密保存' : '未填写，智能功能暂时用不了')}`,
        `播报增强做了什么：${config.announceChanges ? '开启' : '关闭'}`,
        `记住并恢复位置：${config.positionMemory ? '开启' : '关闭'}`,
        `动态变化播报：${config.live.length ? `${config.live.length} 个网站` : '不开启'}`,
      ];
      return `
        <p><strong>设置页里的 ${TOTAL_SETTINGS} 项设置，已经全部在这里改好并保存了</strong>，不需要再去别处补做任何一步：</p>
        <ul>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>
        <p><strong>点下面的「完成并自动关闭本页」按钮，这个引导网页会自动关闭</strong>，以后不会再自动出现；
        关闭之后，<strong>你已经可以用 循光WennSicht 正常浏览网页了</strong>。</p>
        <p>以后想改任何一项，点浏览器工具栏上的 循光WennSicht 图标打开设置页，按 H 在 5 块之间跳、按 3 跳到具体条目；
        设置页顶部还有「重新走一遍『第一次使用』引导」的小按钮。</p>
        <p class="hint">最常用的一个键是 ${TOGGLE_KEY}：在任意网页按一下开启增强，再按一下关闭。</p>`;
    },
    next: '完成并自动关闭本页',
  },
];

// ---------- 渲染与翻页 ----------
// 2026-11-10：有些步只在特定选择下出现（密钥金库只在自己接口时）。
// 用 when() 过滤，进度、上一项/下一项都按「可见步」算，别让用户看到断号。
function visibleSteps() {
  return STEPS.filter((s) => !s.when || s.when());
}
function stepOffset(dir) {
  let i = idx + dir;
  while (i >= 0 && i < STEPS.length) {
    if (!STEPS[i].when || STEPS[i].when()) return i;
    i += dir;
  }
  return -1;
}
async function renderStep(focusIt) {
  // 当前步可能因为前面的选择变成隐藏（例如把接口改回公益中转）⇒ 顺移到下一个可见步
  if (STEPS[idx]?.when && !STEPS[idx].when()) {
    const n = stepOffset(1);
    if (n >= 0) idx = n;
  }
  const step = STEPS[idx];
  const card = $('wizard-step');
  const body = await (typeof step.body === 'function' ? step.body() : step.body);
  card.innerHTML = `<h2 id="wizard-step-title">${step.title}</h2>${body || ''}`
    // 2026-11-11：可见回显**不**再是 live region（否则与 #wizard-said 重复播报同一句话）
    + '<p class="row-status" id="wizard-step-status"></p>';
  const steps = visibleSteps();
  const total = steps.length;
  const pos = Math.max(1, steps.indexOf(step) + 1);
  $('wizard-progress').textContent = typeof step.setting === 'number'
    ? `设置 ${step.setting} / ${TOTAL_SETTINGS} · 总第 ${pos} 步 / 共 ${total} 步`
    : (step.settingLabel
      ? `${step.settingLabel} · 总第 ${pos} 步 / 共 ${total} 步`
      : `第 ${pos} 步 / 共 ${total} 步`);
  const wrap = $('wizard-demo-wrap');
  wrap.hidden = !step.showDemo;
  if (step.showDemo) {
    const frame = $('demo-frame');
    if (frame.getAttribute('srcdoc') === null) frame.srcdoc = DEMO_SRCDOC;
    $('demo-note').textContent = '示例网页里的内容只用于演示，不会保存到任何地方。';
  }
  $('wizard-back').disabled = stepOffset(-1) < 0;
  const nextLabel = typeof step.next === 'function' ? step.next() : step.next;
  $('wizard-next').textContent = nextLabel || (step.id === 'intro' ? '开始' : '下一项');
  if (step.wire) step.wire();
  if (focusIt) { try { card.focus({ preventScroll: false }); } catch { /* 忽略 */ } }
}

// 结束时把 11 项配置整体落盘一次（控件改动时其实已经即时保存过），
// 并写一份完整审计 ws_welcome_config —— 这样「每项都有明确值」是可验证的，不是口头承诺。
async function persistAll() {
  const ai = { provider: config.provider === 'own' ? 'openai-compatible' : 'builtin-relay', enabled: config.aiEnabled };
  if (config.provider === 'own') {
    const cur = await obj('ws_ai_config');
    ai.default = { ...(cur.default || {}), ...config.own };
  }
  await mergeWrite('ws_ai_config', ai);
  // limitEnabled：明确记录「用户到底有没有设上限」，0 张才不会被当成「不限」
  const imgPatch = { limitEnabled: config.limitEnabled === true, hoverReplay: config.hoverReplay };
  if (Number.isFinite(Number(config.dailyLimit))) imgPatch.dailyLimit = Number(config.dailyLimit);
  await mergeWrite('ws_image_config', imgPatch);
  await mergeWrite('ws_ui_config', { announceChanges: config.announceChanges, positionMemory: config.positionMemory });
  await chrome.storage.local.set({ ws_global: config.global });
  await chrome.storage.local.set({
    ws_sites: state.ws_sites,
    ws_sensitive_sites: state.ws_sensitive_sites,
    ws_live_sites: state.ws_live_sites,
    ws_active_sites: state.ws_active_sites,
  });
  await chrome.storage.local.set({
    ws_welcome_config: { ...config, completedAt: Date.now() },
    ws_welcome_done: true,
  });
}

async function finish() {
  try { await persistAll(); } catch (err) {
    say('保存设置时出错：' + String(err?.message || err));
    return; // 不谎报完成，也不关页
  }
  say('设置已全部保存，正在关闭引导页。');
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && typeof tab.id === 'number') await chrome.tabs.remove(tab.id);
    else window.close();
  } catch {
    try { window.close(); } catch { /* 实在关不掉就留在最后一页 */ }
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await readState();
  try { commands = await chrome.commands.getAll(); } catch { commands = []; }
  setToggleKey(commands);
  await renderStep(false);
  $('wizard-back').addEventListener('click', async () => {
    const prev = stepOffset(-1);
    if (prev >= 0) { idx = prev; await renderStep(true); }
  });
  $('wizard-next').addEventListener('click', async () => {
    const step = STEPS[idx];
    if (step.guard) {
      // guard 现在可能要做网络检测（自己的接口），所以统一 await
      const msg = await step.guard();
      if (msg) { say(msg); return; }
    }
    if (step.id === 'finish') { await finish(); return; }
    if (step.wire && typeof step.commit === 'function') await step.commit();
    const nxt = stepOffset(1);
    if (nxt >= 0) { idx = nxt; await renderStep(true); }
  });
});
