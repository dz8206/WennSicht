// 循光WennSicht 设置页逻辑（站点管理 / 全局开关）
//
// 关键约束（技能规则 20）：chrome.permissions.request 必须在用户手势的
// 同步调用链中第一个执行——任何 await 之前调用，否则手势失效。
// 因此所有 input 解析都在 request 之前同步完成。

// 内容脚本注册清单与 ID 约定（定义在 src/data/content-files.js，经 options.html 加载）
const CONTENT_FILES = globalThis.WS_CONTENT_FILES;
const GLOBAL_SCRIPT_ID = globalThis.WS_GLOBAL_SCRIPT_ID;
const siteScriptId = globalThis.WS_siteScriptId;

const $ = (id) => document.getElementById(id);

// 会话 74（owner）：播报里不许写死 Ctrl+Shift+Z —— 一律用用户**实际绑定**的组合键。
// 用户在 chrome://extensions/shortcuts 改过键就跟着变；取不到时退回 manifest 默认值。
let TOGGLE_KEY = 'Ctrl+Shift+Z';
function applyShortcutText() {
  try {
    chrome.commands.getAll((cmds) => {
      const c = (cmds || []).find((x) => x && x.name === 'toggle-wennsicht');
      if (c && c.shortcut) TOGGLE_KEY = c.shortcut;
      // 静态说明里的占位符（data-ws-key="toggle"）同步成实际键
      for (const el of document.querySelectorAll('[data-ws-key="toggle"]')) el.textContent = TOGGLE_KEY;
    });
  } catch { /* 老环境无 commands：保持默认值 */ }
}
document.addEventListener('DOMContentLoaded', applyShortcutText);

// 会话 72 终版：安装组件的阶段机 —— 'idle' | 'announcing' | 'downloading'。
// 用 var 提到脚本最前，保证 setStatus() 在初始化早期被调用时也不会撞 TDZ。
var nvdaPhase = 'idle';

function setStatus(id, text) {
  // 会话 72：播报/下载期间，任何迟到的自动状态更新（refreshNvdaStatus / checkAddonInstalled）
  // 都不得覆盖那句正在念的整句。整句本身走 announceBeforeDownload() 的直接写入，不受此闸影响。
  if (id === 'nvda-status' && nvdaPhase !== 'idle') return;
  $(id).textContent = text;
}

// 主机名是否可接受：既要挡住拼错的裸词，又要放行本机开发地址。
//   ✅ 含点的域名 / IPv4 字面量：example.com、127.0.0.1、192.168.1.10
//   ✅ localhost（可带端口）：http://localhost:36517 —— 2026-10-11 兼容性补丁
//   ❌ 其余单标签裸词：example（多半是 example.com 的笔误）—— 维持原有拦截，
//      否则会把拼错的名字当成一个有效站点收下，用户只会看到「开了但没反应」
function isAcceptableHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost') return true;  // 本机（任意端口）
  if (host.includes('.')) return true;    // 域名 / IPv4 字面量
  return false;
}

// 未写协议时补哪个协议：本机 / IPv4 字面量补 http://（开发服务器几乎都是 http；
// 补 https:// 会得到一个永远匹配不上的 origin，站点开关会「静默失效」——
// 用户看到的是「已开启」，页面却毫无反应）。常规域名仍补 https://
const LOCAL_INPUT_RE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?([/?#]|$)/i;

// 将用户输入解析为 origin（协议 + 主机），失败返回 null
function normalizeOrigin(input) {
  let raw = (input || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = (LOCAL_INPUT_RE.test(raw) ? 'http://' : 'https://') + raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!isAcceptableHostname(u.hostname)) return null; // 排除裸词
    return u.origin;
  } catch {
    return null;
  }
}

// ---------- 已打开页面的即时注入 ----------
// registerContentScripts 只对「之后加载」的页面生效，已打开的标签页不会自动获得
// 内容脚本。这里对匹配的已打开标签页立即注入，避免用户启用后还要手动刷新。
async function injectIntoOpenTabs(patterns) {
  let tabs = [];
  try {
    // 按 URL 过滤需要对应 host 权限（站点模式刚授权；全局模式已授权 <all_urls>）
    tabs = await chrome.tabs.query({ url: patterns });
  } catch {
    return 0; // 无法过滤时静默跳过，用户刷新页面同样生效
  }
  let count = 0;
  for (const t of tabs) {
    if (!t.id) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: CONTENT_FILES });
      count++;
    } catch {
      // 单个标签页失败（页面已关闭等）不影响其它
    }
  }
  return count;
}

// ---------- 添加站点 ----------
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('site-input');
  const origin = normalizeOrigin(input.value); // 同步解析，不 await
  if (!origin) {
    setStatus('add-status', '无法识别该地址，请输入形如 example.com 的网站地址。');
    input.focus();
    return;
  }
  const pattern = origin + '/*';

  // 手势内第一个异步调用必须是 permissions.request（技能规则 20）
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    setStatus('add-status', '权限请求失败：' + (err.message || err));
    return;
  }
  if (!granted) {
    setStatus('add-status', '未授予该站点权限，已取消添加。');
    return;
  }

  // 注册该站点的内容脚本（页面加载后按站点记忆 / 允许列表自动激活）
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: siteScriptId(origin),
        matches: [pattern],
        js: CONTENT_FILES,
        runAt: 'document_idle',
        // v0.2：同源子框架（iframe）也要注入 —— 跨域框架不匹配本站 match pattern，
        // 天然不会被注入（这是设计，不是缺陷）
        allFrames: true,
      },
    ]);
  } catch (err) {
    if (!/duplicate/i.test(String(err?.message || err))) {
      setStatus('add-status', '注册失败：' + (err.message || err));
      return;
    }
    // 已注册则继续（幂等）
  }

  // 写入站点列表
  const { ws_sites = {} } = await chrome.storage.local.get('ws_sites');
  ws_sites[origin] = { addedAt: Date.now() };
  await chrome.storage.local.set({ ws_sites });

  // 2026-11-05 owner 口径：加入允许列表 = 启用该站（打开即自动开启增强），
  // 与页面内「添加站点」流程（SW 的 WS_ADD_SITE）语义对齐；同时覆盖该站历史的
  // 显式 false（重新添加 = 重新启用）。
  const { ws_active_sites: activeMap = {} } = await chrome.storage.local.get('ws_active_sites');
  activeMap[origin] = true;
  await chrome.storage.local.set({ ws_active_sites: activeMap });

  // 对已打开的匹配页面立即注入，省去手动刷新
  const injected = await injectIntoOpenTabs([pattern]);

  setStatus(
    'add-status',
    injected > 0
      ? `已启用 ${origin}。回到该页面即自动开启增强；按 ${TOGGLE_KEY} 可关闭。`
      : `已启用 ${origin}。打开该网站即自动开启增强；按 ${TOGGLE_KEY} 可关闭。`
  );
  input.value = '';
  renderSites();
});

// ---------- 移除站点 ----------
async function removeSite(origin) {
  const id = siteScriptId(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // 未注册则忽略
  }
  // 全站授权仍在手上时，单独移除某个 origin 的授权不会生效（remove 按包含语义匹配），跳过即可。
  // 判断依据必须是**真实权限**而不是 ws_global：关全局后我们刻意保留 <all_urls>（见 global-toggle
  // 关闭分支的注释），此时 ws_global=false 但全站授权仍在，用 ws_global 判断会误导。
  let hasAllUrls = false;
  try {
    hasAllUrls = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    hasAllUrls = false;
  }
  if (!hasAllUrls) {
    try {
      await chrome.permissions.remove({ origins: [origin + '/*'] });
    } catch {
      // 忽略
    }
  }
  const { ws_sites = {} } = await chrome.storage.local.get('ws_sites');
  delete ws_sites[origin];
  await chrome.storage.local.set({ ws_sites });
  // 一并清理该站点的开关记忆（再添加时回到"未交互"初始状态）
  const { ws_active_sites = {} } = await chrome.storage.local.get('ws_active_sites');
  if (origin in ws_active_sites) {
    delete ws_active_sites[origin];
    await chrome.storage.local.set({ ws_active_sites });
  }
  setStatus('sites-status', `已移除 ${origin}。已打开的页面需刷新后生效。`);
  renderSites();
}

// ---------- 全局开关 ----------
$('global-toggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try {
    if (on) {
      // 手势内第一个异步调用（技能规则 20）
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) {
        e.target.checked = false;
        setStatus('global-status', '未授予全站权限，全局启用未开启。');
        return;
      }
      try {
        await chrome.scripting.registerContentScripts([
          {
            id: GLOBAL_SCRIPT_ID,
            matches: ['<all_urls>'],
            js: CONTENT_FILES,
            runAt: 'document_idle',
            // v0.2：同源子框架（iframe）也要注入 —— 跨域框架不匹配本站 match pattern，
        // 天然不会被注入（这是设计，不是缺陷）
        allFrames: true,
          },
        ]);
      } catch (err) {
        if (!/duplicate/i.test(String(err?.message || err))) throw err;
      }
      await chrome.storage.local.set({ ws_global: true });
      // 对已打开的普通网页立即注入（只做动作，不再回显「注入了几页」）
      await injectIntoOpenTabs(['http://*/*', 'https://*/*']);
      setStatus(
        'global-status',
        `全局启用已开启：所有网站打开即自动开启增强，不必逐个添加；想单独关掉某个网站，在该网站按 ${TOGGLE_KEY} 即可。敏感站点默认不处理（在该站连按两次 ${TOGGLE_KEY} 可强制开启）。`
      );
    } else {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [GLOBAL_SCRIPT_ID] });
      } catch {
        // 未注册则忽略
      }
      // ⚠️ 这里**刻意不调** chrome.permissions.remove({origins:['<all_urls>']})（2026-10-10 修复）。
      //   Chrome 的 remove 按**包含语义**匹配 pattern：移除 <all_urls> 会连带清掉该扩展**全部** origin——
      //   ① 「添加站点」列表里各站点的**可选** host 授权（永久丢失，重载也回不来，只能逐个重加）；
      //   ② manifest **必需**授权 http://127.0.0.1/* 与 https://api.wennlicht.us.ci/*（后者被清会让
      //      公益中转 fetch 失败、AI 直接不可用，直到扩展重载或浏览器重启）。
      //   既然不撤销授权，「全局 → 单个站点」的切换就退化成纯逻辑开关：全局脚本已注销 + ws_global=false，
      //   而 storage 里的 ws_sites 列表**原封不动** ⇒ 「关了全局，列表照旧逐条生效」，
      //   这就是 owner 要的「全局 toggle on→off 之后恢复这个列表」。
      await chrome.storage.local.set({ ws_global: false });
      // 立刻让列表里的站点恢复生效（已注入过的页面由内容脚本自身的 __WS_LOADED__ 守卫兜住，不会重复注入）
      const { ws_sites = {} } = await chrome.storage.local.get('ws_sites');
      const patterns = Object.keys(ws_sites).map((o) => o + '/*');
      if (patterns.length) await injectIntoOpenTabs(patterns);
      // 文案只讲用户看得见的结果：关了就是关了，列表照旧生效。
      // 不在这里解释「浏览器层面的授权去留」——那是实现细节，摆在开关旁边只会让人犯迷糊
      //（该事实记在 AGENT_MEMORY/REFERENCE 踩坑表里，供维护者查阅）。
      setStatus(
        'global-status',
        patterns.length
          ? `全局启用已关闭，已恢复为您添加的 ${patterns.length} 个站点。`
          : '全局启用已关闭。'
      );
    }
    await syncSitesModeUi();
  } catch (err) {
    e.target.checked = !on;
    setStatus('global-status', '操作失败：' + (err.message || err));
    await syncSitesModeUi();
  }
});

// ---------- 公益中转（2026-10-07 会话 20） ----------
//
// 页面加载时向 SW 取一次状态缓存到模块变量（endpoint / preset / 服务能力缓存 /
// origin 权限是否已在手）。缓存的目的：ai-save 的公益中转分支里
// permissions.request 必须是用户手势内第一个调用（技能规则 20，任何 await 之前），
// 不能等点击后再去 await 状态。
let relayStash = { configured: false, endpoint: '', preset: null, relayConfig: null, originGranted: false };

async function refreshRelayStash(force = false) {
  const keepGranted = relayStash.originGranted;
  try {
    const st = await chrome.runtime.sendMessage({ type: 'WS_RELAY_STATE', refresh: !!force });
    if (st?.ok) {
      relayStash = {
        configured: !!st.configured,
        endpoint: st.endpoint || '',
        preset: st.preset || null,
        relayConfig: st.relayConfig || null,
        originGranted: keepGranted,
      };
    }
  } catch { /* SW 未响应：保持现状 */ }
  try {
    relayStash.originGranted = relayStash.endpoint
      ? await chrome.permissions.contains({ origins: [new URL(relayStash.endpoint).origin + '/*'] })
      : false;
  } catch {
    relayStash.originGranted = false;
  }
}

function readAiSource() {
  const el = document.querySelector('input[name="ai-source"]:checked');
  return el?.value || 'builtin';
}

// 已保存的接口来源（≠ radio 的当前选择）。init() 按存储填好，保存成功后再更新。
// 只有「公益中转已经落地」才敢把密钥金库那一节收起来。
let savedProvider = 'builtin-relay';
let vaultSectionShown = null; // null = 尚未判定（init 首次同步）；用于避免重复渲染

// 密钥金库一节只在「使用自己的接口」时有意义：公益中转走服务端预配，ai.js 对
// needsApiKey:false 的 provider 根本不读金库。owner 2026-10-10 反馈——已选并保存公益中转时
// 还显示「设置主密码」，会让人以为必须配置而卡在这一步。
// 口径：已保存公益中转 且 radio 当前仍选公益中转 → 隐藏；一切换到「自己的接口」立即显示。
function syncVaultSectionUi() {
  const need = !(savedProvider === 'builtin-relay' && readAiSource() === 'builtin');
  $('vault-section').hidden = !need;
  // 由隐藏转为可见时补一次最新金库状态（首次判定 vaultSectionShown === null 不补，
  // init() 末尾本来就会 renderVaultState()）
  if (vaultSectionShown === false && need) renderVaultState().catch(() => {});
  vaultSectionShown = need;
}

// 「大模型接口」一节里同样只属于 BYOK 的东西：保存按钮、清除前置档/默认档密钥、
// 以及那段校验结果说明（「已保存。前置档文本：未配置，跳过；默认档文本：可用（…）」）。
// owner 2026-10-10 反馈——选了公益中转后这些还杵在那儿，看着像漏配了前置档。
// 公益中转是零配置的（出厂预配 + manifest 已带 host 权限），这一侧只该有一个「刷新状态」。
// 判定口径与密钥金库一节保持一致：已保存公益中转 且 radio 当前仍选公益中转 → 收起。
// 尚未保存公益中转时（例如刚从「自己的接口」切过来）仍显示保存按钮，
// 否则这次切换就无处落地——但那种状态下按钮本来也只在真正用得着的时候才出现。
let aiActionsShown = null;
function syncAiModeUi() {
  const relayOnly = savedProvider === 'builtin-relay' && readAiSource() === 'builtin';
  $('ai-custom-actions').hidden = relayOnly;
  // hidden ⇒ display:none：三个按钮与 #ai-status 一起退出无障碍树（Tab 也到不了）
  if (aiActionsShown === false && !relayOnly) {
    // 由隐转显：密钥布尔与上次校验结果可能已变（例如在别处清过密钥），补一次
    renderKeyState().catch(() => {});
  }
  aiActionsShown = !relayOnly;
}

function applySourceUi() {
  const builtin = readAiSource() === 'builtin';
  $('ai-custom-fields').hidden = builtin;
  $('ai-builtin-panel').hidden = !builtin;
  renderBuiltinStatus();
  syncAiModeUi();
  syncVaultSectionUi();
}

// 公益中转一侧的状态行。prefix 用于把一次性结论（保存/校验结果）并进同一行，
// 因为公益中转模式下 #ai-status 是收起的——那一侧只有这一个反馈面。
function renderBuiltinStatus(prefix = '') {
  const el = $('ai-builtin-status');
  if (!relayStash.configured) {
    el.textContent = '当前构建未内置公益中转端点，公益中转不可用。请选择「使用自己的接口」。';
    return;
  }
  // 2026-10-10（owner）：这里只说用户用得上的两件事 —— 就绪 与 剩余额度。
  // 服务端模型清单（文本/视觉/分类是哪个模型）、服务条款式 notice、以及"更新于 几时几分"
  // 都是内部信息，摆给用户只会挤占注意力（原来的整行读起来像运维面板）。
  let line = '公益中转已就绪。';
  const rc = relayStash.relayConfig;
  if (rc?.error) {
    line += ` 状态读取失败：${rc.error}`;
  } else if (rc?.data) {
    if (rc.data.paused) line += ' 服务暂停中。';
    const q = rc.data.quota || {};
    if (typeof q.deviceRemaining === 'number') line += ` 本机今日剩余额度 ${q.deviceRemaining} 次。`;
  }
  el.textContent = prefix ? `${prefix} ${line}` : line;
}

// 公益中转的校验结论只说人话：公益档的两档都由服务端预配，用户不需要区分前置/默认档，
// 照搬 BYOK 那套「前置档文本：未配置，跳过」写进来只是噪音。
function relayVerifySummary(res) {
  if (!res) return '已保存，校验未返回结果。';
  const tiers = [res.defaultText, res.defaultVision].filter(Boolean);
  const bad = tiers.filter((r) => !r.ok && !r.skipped);
  if (bad.length) {
    return '已保存，但链路校验未通过：' + bad.map((r) => r.error).join('；') + '。';
  }
  return '已保存，链路可用。';
}

$('ai-builtin-refresh').addEventListener('click', async () => {
  $('ai-builtin-status').textContent = '正在刷新公益中转状态…';
  await refreshRelayStash(true);
  renderBuiltinStatus();
});

document.querySelectorAll('input[name="ai-source"]').forEach((el) => {
  el.addEventListener('change', applySourceUi);
});

// ---------- 大模型接口配置（2026-10-04 口径：primary 前置档可选 / default 默认档必填） ----------

// 读取表单当前值（同步，便于在权限请求前完成）。
// apiKey 只在本次调用链的内存中存在，绝不写回 DOM、绝不落盘明文。
function readAiForm() {
  const trim = (id) => $(id).value.trim().replace(/\/+$/, '');
  return {
    primary: {
      baseUrl: trim('ai-primary-baseurl'),
      textModel: $('ai-primary-textmodel').value.trim(),
      visionModel: $('ai-primary-visionmodel').value.trim(),
    },
    default: {
      baseUrl: trim('ai-default-baseurl'),
      textModel: $('ai-default-textmodel').value.trim(),
      visionModel: $('ai-default-visionmodel').value.trim(),
      decisionModel: $('ai-default-decisionmodel').value.trim(),
    },
    primaryKey: $('ai-primary-apikey').value.trim(),
    defaultKey: $('ai-default-apikey').value.trim(),
  };
}

// 显示双档密钥的保存状态。只显示布尔状态，绝不回显任何字符。
// 密钥的真实状态由 SW 持有（密钥金库保管），本页只经消息询问。
async function renderKeyState() {
  let state = { primary: false, default: false };
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' });
    state = { primary: !!res?.primary, default: !!res?.default };
  } catch {
    /* 保持默认 */
  }
  $('ai-primary-key-state').textContent = state.primary ? '（已保存，不会再次显示）' : '（尚未保存）';
  $('ai-default-key-state').textContent = state.default ? '（已保存，不会再次显示）' : '（尚未保存）';
  $('ai-clear-primary').hidden = !state.primary;
  $('ai-clear-default').hidden = !state.default;
  $('ai-primary-apikey').placeholder = state.primary ? '留空表示沿用已保存的密钥' : '';
  $('ai-default-apikey').placeholder = state.default ? '留空表示沿用已保存的密钥' : '';
  return state;
}

// 保存：手势内第一个异步调用必须是 permissions.request（技能规则 20）。
// 两档可能是不同服务商——两个 origin 合并进一次 permissions.request，
// 一次授权弹窗覆盖两档（拆成两次调用会消耗掉用户手势）。
// 口径（2026-11-15 owner 定案）：默认档必填（地址 + 文本模型 + 视觉模型 + 决策模型 + 密钥）；
// 前置档要么整块留空（只用默认档），要么填 地址 + 密钥（模型可只填一部分，没填的角色回落默认档）。
$('ai-save').addEventListener('click', () => (readAiSource() === 'builtin' ? saveBuiltinAi() : saveCustomAi()));

// 公益中转保存（2026-10-07 会话 20）：无密钥、无自定义参数——预配由 SW 下发。
// 权限注意：权限不在手时 permissions.request 必须是手势内第一个调用（技能规则 20），
// 因此状态在页面加载时已缓存进 relayStash，本函数在 request 之前不引入任何 await。
// 公测构建（manifest 已内置中转 host 权限）时 originGranted=true，连弹窗都没有。
// 反馈面（2026-10-10）：公益中转模式下 #ai-status 属 BYOK 区、已收起，
// 因此本函数的所有消息一律写进公益中转自己的状态行 #ai-builtin-status。
async function saveBuiltinAi() {
  const say = (msg) => { $('ai-builtin-status').textContent = msg; };
  if (!relayStash.configured || !relayStash.preset) {
    say('当前构建未内置公益中转端点，公益中转不可用。请选择「使用自己的接口」并完成配置。');
    return;
  }
  if (!relayStash.originGranted) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [new URL(relayStash.endpoint).origin + '/*'] });
    } catch (err) {
      say('权限请求失败：' + (err.message || err));
      return;
    }
    if (!granted) {
      say('未授权访问公益中转，配置未保存。');
      return;
    }
    relayStash.originGranted = true;
  }
  // 密钥布尔如实写 false：公益档不使用金库密钥（用户日后切回自定义接口时，
  // 已保存的金库密钥仍在，按当时实际状态回写）。
  await WS_AI_CONFIG_SAVE(
    {
      provider: 'builtin-relay',
      primary: { baseUrl: '', textModel: '', visionModel: '', reasoning: {} },
      default: relayStash.preset,
    },
    { hasPrimaryKey: false, hasDefaultKey: false }
  );
  // 公益中转已落地 → 密钥金库一节与 BYOK 按钮组立即收起
  savedProvider = 'builtin-relay';
  syncVaultSectionUi();
  syncAiModeUi();
  say('已保存，正在校验公益中转链路…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_AI_VERIFY' });
    renderBuiltinStatus(relayVerifySummary(res));
  } catch (err) {
    renderBuiltinStatus('已保存，但校验未完成：' + (err.message || err));
  }
}

// 「使用自己的接口」保存（原逻辑，2026-10-04 口径原样保留）：
// 手势内第一个异步调用必须是 permissions.request（技能规则 20）。
// 两档可能是不同服务商——两个 origin 合并进一次 permissions.request，
// 一次授权弹窗覆盖两档（拆成两次调用会消耗掉用户手势）。
// 口径（2026-11-15 owner 定案 · 最终版）：
//   默认档 = **所有格子必填**（接口地址 + 文本模型 + 视觉模型 + 决策模型；密钥在权限请求后用金库状态校验）。
//   前置档 = 可整块留空；**写了任何一项就必须有 接口 + 密钥**；模型可只填一部分，
//            没填的那一类（文本/视觉）运行时直接改用默认档的模型。
async function saveCustomAi() {
  const cfg = readAiForm(); // 同步读取，不引入 await

  // 校验：接口地址可解析
  const origins = [];
  for (const tier of ['primary', 'default']) {
    const url = cfg[tier].baseUrl;
    if (!url) continue;
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      setStatus('ai-status', `${tier === 'primary' ? '前置档' : '默认档'}接口地址无法解析，请输入形如 https://openrouter.ai/api/v1 的地址。`);
      $(`ai-${tier}-baseurl`).focus();
      return;
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  // 默认档：所有格子必填（地址 + 文本模型 + 视觉模型；密钥稍后用金库状态校验）
  if (!cfg.default.baseUrl) {
    setStatus('ai-status', '默认档不能留空：请填写默认档接口地址。');
    $('ai-default-baseurl').focus();
    return;
  }
  if (!cfg.default.textModel) {
    setStatus('ai-status', '默认档请填写文本模型 ID。');
    $('ai-default-textmodel').focus();
    return;
  }
  if (!cfg.default.visionModel) {
    setStatus('ai-status', '默认档请填写视觉模型 ID（图片描述需要）。');
    $('ai-default-visionmodel').focus();
    return;
  }
  // 2026-11-15 owner 定案：决策模型与文本/视觉模型同口径**必填**（不再静默补 typesafe/jev-1.13）。
  if (!cfg.default.decisionModel) {
    setStatus('ai-status', '默认档请填写决策模型 ID（场景分类与链接意图判定需要）。');
    $('ai-default-decisionmodel').focus();
    return;
  }
  // 前置档：可整块留空；一旦写了任何一项（地址/文本模型/视觉模型/密钥），
  // 就只要求 接口地址 + 密钥 —— 模型允许一个都不写。
  const primaryTouched = !!(cfg.primary.baseUrl || cfg.primary.textModel || cfg.primary.visionModel || cfg.primaryKey);
  if (primaryTouched && !cfg.primary.baseUrl) {
    setStatus('ai-status', '检测到前置档已填写，请补齐接口地址；若不用前置档，可整块留空。');
    $('ai-primary-baseurl').focus();
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: origins.map((o) => o + '/*') });
  } catch (err) {
    setStatus('ai-status', '权限请求失败：' + (err.message || err));
    return;
  }
  if (!granted) {
    setStatus('ai-status', '未授权访问接口地址，配置未保存。');
    return;
  }

  // 密钥：每档有新输入才覆盖；留空表示沿用已保存的。
  // 明文经消息交给 SW（再由 SW 写入金库密文），本页不留任何密钥形态。
  const keySaves = [];
  if (cfg.primaryKey) keySaves.push(['primary', cfg.primaryKey]);
  if (cfg.defaultKey) keySaves.push(['default', cfg.defaultKey]);
  const keyLabels = { primary: '前置档', default: '默认档' };
  for (const [slot, key] of keySaves) {
    let saved;
    try {
      saved = await chrome.runtime.sendMessage({ type: 'WS_KEY_SAVE', slot, key });
    } catch (err) {
      saved = { ok: false, error: String(err?.message || err) };
    }
    if (!saved?.ok) {
      setStatus('ai-status', `${keyLabels[slot]}密钥保存失败：` + (saved?.error || ''));
      return;
    }
  }
  const keyState = await chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' });
  const keySaved = { primary: !!keyState?.primary, default: !!keyState?.default };
  // 前置档：写了任何一项就必须有密钥（这次新填或此前已存都算），否则等于配了个调不通的档。
  if (primaryTouched && !keySaved.primary) {
    setStatus('ai-status', '检测到前置档已填写，请补齐API key；若不用前置档，可整块留空。');
    $('ai-primary-apikey').focus();
    return;
  }
  // 默认档密钥必填（否则智能功能按口径不可用）——须等权限请求后才检查（手势约束）
  if (!keySaved.default) {
    setStatus('ai-status', '默认档 API key尚未保存：默认档必填，请填写密钥后重新保存。');
    $('ai-default-apikey').focus();
    return;
  }
  // provider 必须显式写回：WS_AI_CONFIG_SAVE 是浅合并（{...current, ...cfg}），
  // 不带 provider 时旧的 'builtin-relay' 会残留 —— 后果是 callTier 按公益中转处理
  // （needsApiKey:false → 不读金库、不带 Authorization），却把请求发往自定义 baseUrl，
  // OpenRouter 因无鉴权头回 401「Failed to authenticate request with Clerk」
  //（2026-10-11 实锤：设置页「保存」后 provider 仍为 builtin-relay）。
  await WS_AI_CONFIG_SAVE(
    { provider: 'openai-compatible', primary: cfg.primary, default: cfg.default },
    { hasPrimaryKey: keySaved.primary, hasDefaultKey: keySaved.default }
  );
  // 已切到「自己的接口」→ 密钥金库一节必须可见（保存成功后 radio 一定在 custom 上）
  savedProvider = 'openai-compatible';
  syncVaultSectionUi();

  // 清空密钥输入框：明文不留在表单里
  $('ai-primary-apikey').value = '';
  $('ai-default-apikey').value = '';
  await renderKeyState();

  // 保存后立即校验各档链路。此处刻意不带任何配置：
  // SW 会读已保存的配置与已加密的密钥，因此校验通过就证明整条链路（含解密）是通的。
  setStatus('ai-status', '已保存，正在校验模型…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_AI_VERIFY' });
    setStatus('ai-status', describeVerify(res));
  } catch (err) {
    setStatus('ai-status', '已保存。校验未完成：' + err.message);
  }
}

function describeVerify(res) {
  if (!res) return '已保存。校验未返回结果。';
  const fmt = (label, r) => {
    if (!r) return `${label}：未校验`;
    if (r.skipped) return `${label}：未配置，跳过`;
    if (r.ok) return `${label}：可用（${r.model}）`;
    return `${label}：失败 — ${r.error}`;
  };
  const parts = [
    fmt('前置档文本', res.primaryText),
    fmt('前置档视觉', res.primaryVision),
    fmt('默认档文本', res.defaultText),
    fmt('默认档视觉', res.defaultVision),
  ];
  const text = '已保存。' + parts.join('；');
  // 持久化上次校验结果（开放问题 #2 落地，2026-09-28）：重开设置页时还能看到
  // 上次校验结论，不用为了确认链路再花一次调用。只存摘要文本与时间，不存密钥。
  chrome.storage.local.set({ ws_last_verify: { text, at: Date.now() } });
  return text;
}

// 初始化时展示上次校验结果（如有）
async function renderLastVerify() {
  try {
    const { ws_last_verify } = await chrome.storage.local.get('ws_last_verify');
    if (ws_last_verify?.text) {
      const when = new Date(ws_last_verify.at).toLocaleString();
      setStatus('ai-status', `${ws_last_verify.text}（上次校验：${when}）`);
    }
  } catch {
    // 读不到就静默（首次使用无此记录属正常）
  }
}

// 清除密钥（需用户手势）：按档清除；默认档被清后 AI 功能不可用（提示重新填写）
async function clearKeySlot(slot) {
  const label = slot === 'primary' ? '前置档' : '默认档';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_KEY_CLEAR', slot });
    if (!res?.ok) throw new Error(res?.error || '未知错误');
  } catch (err) {
    setStatus('ai-status', `${label}密钥清除失败：` + (err.message || err));
    return;
  }
  const state = await chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' });
  await chrome.storage.local.set({
    ws_ai_config: {
      ...(await readStoredAiConfig()),
      hasPrimaryKey: !!state?.primary,
      hasDefaultKey: !!state?.default,
    },
  });
  await renderKeyState();
  setStatus('ai-status', slot === 'default'
    ? `已清除${label}密钥。默认档密钥缺失后智能功能不可用，请尽快重新填写。`
    : `已清除${label}密钥。`);
}

$('ai-clear-primary').addEventListener('click', () => clearKeySlot('primary'));
$('ai-clear-default').addEventListener('click', () => clearKeySlot('default'));

async function readStoredAiConfig() {
  const { ws_ai_config = {} } = await chrome.storage.local.get('ws_ai_config');
  const cfg = { ...ws_ai_config };
  delete cfg.apiKey; // 防御：任何残留的明文字段都不带回来
  return cfg;
}

// 保存非敏感配置 + 双档密钥布尔标志（不含密钥内容）。
// keyFlags 只接受完整对象（{ hasPrimaryKey, hasDefaultKey }）；不传则不动密钥标志，
// 防止「只改开关」的调用把标志误写成 false。
async function WS_AI_CONFIG_SAVE(cfg, keyFlags) {
  const current = await readStoredAiConfig();
  const next = { ...current, ...cfg };
  if (keyFlags && typeof keyFlags === 'object' && 'hasDefaultKey' in keyFlags) {
    next.hasPrimaryKey = !!keyFlags.hasPrimaryKey;
    next.hasDefaultKey = !!keyFlags.hasDefaultKey;
  }
  await chrome.storage.local.set({ ws_ai_config: next });
}

// ---------- 图片描述设置 ----------

// 2026-11-10：上限改由「要不要设上限」复选框明确表达。不勾 = 不设上限（输入框禁用）；
// 勾了才填数字，0 表示一天都不生成描述 —— 单靠 dailyLimit 存不下这个区别（0 原先是「不限」）。
function syncImgLimit() {
  const on = $('img-limit-on');
  const num = $('img-limit');
  const hint = $('img-limit-hint');
  if (!on || !num) return;
  num.disabled = !on.checked;
  if (hint) {
    hint.textContent = on.checked
      ? '达到上限后剩下的图片只按本地词典提示，第二天自动恢复；填 0 表示一天都不生成图片描述。'
      : '不设上限：当天有多少张缺说明的图片就描述多少张，第二天重新计。';
  }
}
$('img-limit-on')?.addEventListener('change', syncImgLimit);

$('ai-save2').addEventListener('click', async () => {
  const master = $('ai-master').checked;
  const limitOn = $('img-limit-on').checked;
  const raw = $('img-limit').value.trim();
  let limit;
  if (raw === '') {
    if (limitOn) {
      setStatus('img-status', '已经勾选「限制每天最多描述多少张图片」，请填写限额。');
      $('img-limit').focus();
      return;
    }
    limit = 50;
  } else {
    limit = Number(raw);
  }
  // 2026-11-14 owner：**不设 0–500 上限**，用户想填多少填多少；只保证是 ≥0 的整数。
  if (!Number.isInteger(limit) || limit < 0) {
    setStatus('img-status', '图片描述每日上限请填写非负整数；0 表示不生成描述。');
    $('img-limit').focus();
    return;
  }
  // 2026-09-30 用户决策：悬停重听默认关闭（全盲靠 G 导航；供低视力鼠标用户可选开启）
  const hoverReplay = $('hover-replay').checked;

  // 开启智能场景解析增强需要基线档齐备；公益中转模式（2026-10-07）下基线档由
  // 预配保证（别名模型恒齐备、无需密钥），只检查端点是否在位——提前明确提示，
  // 避免用户开了之后看到「没反应」却不知原因
  const keyState = await chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' }).catch(() => null);
  if (master) {
    const missing = [];
    if (readAiSource() === 'builtin') {
      if (!relayStash.configured) {
        missing.push('公益中转端点（当前构建未内置，请改用「使用自己的接口」并完成配置）');
      }
    } else {
      if (!$('ai-default-baseurl').value.trim()) missing.push('默认档接口地址');
      if (!$('ai-default-textmodel').value.trim() && !$('ai-default-visionmodel').value.trim()) {
        missing.push('默认档模型 ID（文本或视觉）');
      }
      if (!keyState?.default) missing.push('默认档 API 密钥');
    }
    if (missing.length) {
      setStatus('img-status', '请先在上方「大模型接口」完成：' + missing.join('、')
        + '。基线未就位时智能功能不可用。');
      return;
    }
  }

  await WS_AI_CONFIG_SAVE(
    { enabled: master },
    keyState ? { hasPrimaryKey: !!keyState.primary, hasDefaultKey: !!keyState.default } : null
  );
  // 合并写：别把同对象里的其它键（含本次新增的 limitEnabled）冲掉
  const curImg = (await chrome.storage.local.get('ws_image_config')).ws_image_config || {};
  await chrome.storage.local.set({
    ws_image_config: { ...curImg, dailyLimit: limit, limitEnabled: limitOn, hoverReplay },
  });
  setStatus(
    'img-status',
    (master
      ? '已保存。智能场景解析增强已开启：场景解析播报、页面摘要（Ctrl+Shift+S）、图片描述、模糊链接意图补充将按页面场景工作。'
      : '已保存。智能场景解析增强已关闭，不会调用大模型。')
    + (limitOn ? ` 每天最多 ${limit} 张图片描述。` : ' 图片描述不设每日上限。')
    + (hoverReplay ? ' 悬停重听已开启。' : '')
  );
  renderUsage();
});

async function renderUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const { ws_ai_usage, ws_image_config = {} } = await chrome.storage.local.get([
    'ws_ai_usage',
    'ws_image_config',
  ]);
  const used = ws_ai_usage && ws_ai_usage.date === today ? Number(ws_ai_usage.count) || 0 : 0;
  // 与内容脚本同口径：limitEnabled 缺省 ⇒ 按 dailyLimit>0 推断（老数据不变）
  const rawLimit = Number(ws_image_config.dailyLimit);
  const limitOn = ws_image_config.limitEnabled === true
    || (ws_image_config.limitEnabled == null && Number.isFinite(rawLimit) && rawLimit > 0);
  const limit = limitOn ? Math.max(0, Math.round(rawLimit || 0)) : 0;
  $('img-usage').textContent = !limitOn
    ? `今日已调用 ${used} 次（未设置上限）。`
    : (limit === 0
      ? `今日已调用 ${used} 次（上限 0 次：图片描述已关闭）。`
      : `今日已调用 ${used} 次，上限 ${limit} 次。`);
}

// ---------- 密钥金库主密码 ----------
// 金库本体在 SW（key-vault.js）。本区块只经消息控制：设置/更新主密码、解锁、锁定；
// 明文主密码经消息交给 SW 后立即从表单清除，本页不留任何密码形态。
async function renderVaultState() {
  let st = null;
  try {
    st = await chrome.runtime.sendMessage({ type: 'WS_KEY_STATE' });
  } catch {
    return;
  }
  const stateLine = $('vault-state');
  if (!st) {
    stateLine.textContent = '金库状态未知（Service Worker 未响应）。';
    return;
  }
  if (st.needsSetup) {
    stateLine.textContent = st.hasKey
      ? '检测到旧版密钥保管方式，已自动迁移到加密金库（临时保护）。强烈建议立即设置您自己的主密码。'
      : '尚未设置主密码。设置后 API 密钥才会被加密保存。';
  } else if (st.locked) {
    stateLine.textContent = '金库已锁定。解锁后扩展才能使用已保存的 API 密钥。';
  } else if (st.unlocked) {
    stateLine.textContent = st.transitional
      ? '已解锁（迁移过渡保护）。强烈建议设置您自己的主密码。'
      : '已解锁：本浏览器会话内可正常使用 API 密钥，重开浏览器后需再解锁一次。';
  } else {
    stateLine.textContent = '金库未初始化。';
  }
  $('vault-pass-row').hidden = false;
  $('vault-unlock-row').hidden = !st.locked;
  $('vault-lock').hidden = !st.unlocked;
  return st;
}

$('vault-save').addEventListener('click', async () => {
  const pw = $('vault-pass').value;
  if (pw.length < 8) {
    setStatus('vault-status', '主密码至少 8 位。');
    $('vault-pass').focus();
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_KEY_SETUP', password: pw });
    if (!res?.ok) throw new Error(res?.error || '未知错误');
    setStatus('vault-status', '主密码已保存。API 密钥已用您的密码加密；本会话已解锁。');
  } catch (err) {
    setStatus('vault-status', '设置失败：' + (err.message || err));
  }
  $('vault-pass').value = ''; // 明文不留在表单
  await renderVaultState();
});

$('vault-do-unlock').addEventListener('click', async () => {
  const pw = $('vault-unlock').value;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'WS_KEY_UNLOCK', password: pw });
    if (!res?.ok) throw new Error(res?.error || '主密码不正确或金库已损坏');
    setStatus('vault-status', '已解锁。本浏览器会话内不会再询问。');
  } catch (err) {
    setStatus('vault-status', '解锁失败：' + (err.message || err));
  }
  $('vault-unlock').value = '';
  await renderVaultState();
});

$('vault-unlock').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('vault-do-unlock').click();
  }
});

$('vault-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('vault-save').click();
  }
});

$('vault-lock').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'WS_KEY_LOCK' });
    setStatus('vault-status', '已锁定。解锁前扩展无法使用已保存的 API 密钥。');
  } catch (err) {
    setStatus('vault-status', '锁定失败：' + (err.message || err));
  }
  await renderVaultState();
});

// ---------- 浏览便利功能（v0.2 第 7 项：焦点位置记忆） ----------
// 只存偏好布尔；真正的位置记录由内容脚本存 ws_positions（本地，键不含原始查询串）。
// 「播报增强做了什么」（2026-10-31 · owner）：默认开。关掉后内容脚本只说
// 「无障碍增强已开启」，不再逐项报告「修复 N 个标题 / 补出 N 个地标 / 隐藏 N 个噪音块」，
// 图片管线的「已为 N 张图片生成…」统计也静音；**出错 / 无法加载 / 验证码照旧播**。
// 存在 ws_ui_config 里（与「记住并恢复上次浏览位置」同一个偏好对象，口径一致）。
$('announce-changes').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const { ws_ui_config = {} } = await chrome.storage.local.get('ws_ui_config');
  await chrome.storage.local.set({ ws_ui_config: { ...ws_ui_config, announceChanges: on } });
  setStatus('announce-status', on
    ? '已开启：开启增强时会说明修复了哪些内容。'
    : '已关闭：只播「无障碍增强已开启」，不再逐项说明改了什么。图片加载失败等提示仍会播。');
});

$('position-memory').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const { ws_ui_config = {} } = await chrome.storage.local.get('ws_ui_config');
  await chrome.storage.local.set({ ws_ui_config: { ...ws_ui_config, positionMemory: on } });
  setStatus('ux-status', on
    ? '已开启：刷新或后退/前进回到页面时，将恢复到上次浏览位置。'
    : '已关闭：不再记录和恢复浏览位置。已记录的位置会在下次浏览时逐步更新。');
});

// ---------- 动态变化播报（v0.2 第 10 项：默认关、站点级开） ----------
// 内容脚本在开启增强时把站点登记进 ws_live_sites（默认关）；这里列出并允许逐站开启。
// 开关后向已打开的同源标签页发 WS_LIVE_REFRESH，无需刷新页面即可生效。
// 通知已打开的同源页面即时生效（无需刷新）；任何失败都不影响已经存好的设置。
async function notifyLiveRefresh(origin) {
  try {
    const tabs = await chrome.tabs.query({ url: origin + '/*' });
    for (const t of tabs) {
      if (t.id) await chrome.tabs.sendMessage(t.id, { type: 'WS_LIVE_REFRESH' }).catch(() => {});
    }
  } catch {
    /* 没有 tabs 权限时忽略，刷新后生效 */
  }
}

async function setLiveSite(origin, on) {
  const { ws_live_sites: cur = {} } = await chrome.storage.local.get('ws_live_sites');
  const r = cur[origin] || {};
  // at 与内容脚本的登记格式保持一致：内容脚本按 at 做 FIFO 淘汰，缺这个字段会被优先清掉
  cur[origin] = { ...r, on, at: r.at || Date.now(), changedAt: Date.now() };
  await chrome.storage.local.set({ ws_live_sites: cur });
  await notifyLiveRefresh(origin);
}

// 只列「已开启播报」的站点（owner 2026-10-10：原来把访问过的站点全列出来，
// 用户在几千条里导航不现实）→ 改成下面那个填空框负责添加，这里只管已开启的。
async function renderLiveSites() {
  const { ws_live_sites: store = {} } = await chrome.storage.local.get('ws_live_sites');
  const list = $('live-list');
  if (!list) return;
  list.textContent = '';
  const onOrigins = Object.keys(store).filter((o) => store[o]?.on === true).sort();
  const empty = $('live-empty');
  if (empty) empty.hidden = onOrigins.length > 0;
  for (const origin of onOrigins) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = '关闭';
    btn.setAttribute('aria-label', `关闭 ${origin} 的动态变化播报`);
    btn.addEventListener('click', async () => {
      await setLiveSite(origin, false);
      setStatus('live-status', `已关闭 ${origin} 的动态变化播报。`);
      renderLiveSites();
    });
    li.append(name, btn);
    list.append(li);
  }
}

$('live-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('live-input');
  const origin = normalizeOrigin(input.value); // 同步解析，不 await
  if (!origin) {
    setStatus('live-status', '无法识别该地址，请输入形如 example.com 的网站地址。');
    input.focus();
    return;
  }
  await setLiveSite(origin, true);
  setStatus('live-status', `已开启 ${origin} 的动态变化播报。`);
  input.value = '';
  renderLiveSites();
});

// ---------- 敏感站点保护（v0.2 第 8 项） ----------
// 内容脚本在本地判定出政务/医疗/金融类站点后登记到 ws_sensitive_sites；
// 这里列出并允许用户为单个站点放行（默认不放行——隐私侧从严）。
const CATEGORY_LABEL = { gov: '政务', medical: '医疗健康', finance: '金融理财' };

// 只列「已放行」的站点（owner 2026-10-10：原来把检测到的敏感站点全列出来，
// 用户在几千条里导航不现实）→ 改成下面那个填空框负责放行，这里只管已放行的。
//
// 2026-10-24：敏感站点改为「默认整页不处理」，放行因此有两个独立开关，列表必须都列出来：
//   allowAI=true      → 允许把页面内容发给 AI（表单 / 旧数据）
//   forceEnhance=true → 在本站点强制开启了增强（页面内 Ctrl+Shift+Z 再按一次 Z）
// 两者刻意分开（强制做本地修复 ≠ 允许外发）。**条目里必须写清是哪一种**，
// 否则盲用户无从知道「我到底给了它什么权限」——与 2026-10-03 allowAI 提示句同一教训。
async function renderSensitiveSites() {
  const { ws_sensitive_sites = {} } = await chrome.storage.local.get('ws_sensitive_sites');
  const list = $('sensitive-list');
  if (!list) return;
  list.textContent = '';
  const origins = Object.keys(ws_sensitive_sites)
    .filter((o) => ws_sensitive_sites[o]?.allowAI === true || ws_sensitive_sites[o]?.forceEnhance === true)
    .sort();
  const empty = $('sensitive-empty');
  if (empty) empty.hidden = origins.length > 0;
  for (const origin of origins) {
    const rec = ws_sensitive_sites[origin] || {};
    const li = document.createElement('li');
    const name = document.createElement('span');
    const states = [];
    if (rec.forceEnhance === true) states.push('已放行增强');
    if (rec.allowAI === true) states.push('允许发送内容');
    const catPrefix = rec.category
      ? `${CATEGORY_LABEL[rec.category] || '敏感'}类；`
      : '';
    name.textContent = `${origin}（${catPrefix}${states.join('，')}）`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = '恢复保护';
    btn.setAttribute('aria-label', `恢复 ${origin} 的默认保护`);
    btn.addEventListener('click', async () => {
      const { ws_sensitive_sites: cur = {}, ws_active_sites: active = {} } =
        await chrome.storage.local.get(['ws_sensitive_sites', 'ws_active_sites']);
      const r = cur[origin] || {};
      // 两个开关一起清：条目只有「全放行 / 全恢复」两种状态，避免盲用户在两个按钮之间猜
      cur[origin] = { ...r, allowAI: false, forceEnhance: false, allowChangedAt: Date.now() };
      // 2026-10-25 SOLE_TRUTH：还必须把「本站点已开启」这条记忆一起清掉。
      // 否则闸门看 ws_active_sites[origin]===true 会认为「用户点名过」，下一次打开又自动放行
      // ——「恢复保护」就成了摆设。（删键而不是写 false：删掉后全局模式下仍会播一句
      // 「默认关闭 + 怎么强制开启」，用户知道现在是什么状态。）
      delete active[origin];
      await chrome.storage.local.set({ ws_sensitive_sites: cur, ws_active_sites: active });
      setStatus('sensitive-status',
        `已恢复 ${origin} 的默认保护：该站点不再自动开启增强，也不再外发内容。刷新页面后生效。`);
      renderSensitiveSites();
    });
    li.append(name, btn);
    list.append(li);
  }
}

$('sensitive-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('sensitive-input');
  const origin = normalizeOrigin(input.value); // 同步解析，不 await
  if (!origin) {
    setStatus('sensitive-status', '无法识别该地址，请输入形如 example.com 的网站地址。');
    input.focus();
    return;
  }
  const { ws_sensitive_sites: cur = {} } = await chrome.storage.local.get('ws_sensitive_sites');
  const r = cur[origin] || {};
  // 放行 = 增强 + AI 一起放开：只放 AI 而不放增强是空头承诺
  //（站点默认整页不处理，AI 根本轮不到运行）。
  cur[origin] = { ...r, allowAI: true, forceEnhance: true, allowChangedAt: Date.now() };
  await chrome.storage.local.set({ ws_sensitive_sites: cur });
  setStatus('sensitive-status',
    `已为 ${origin} 放行：站点页面内容会发送到外部服务器。刷新页面后生效。`);
  input.value = '';
  renderSensitiveSites();
});

// 列表与页面状态必须同步（2026-10-24）：用户在某个网页里按了「两次 Z」强制开启，
// 这条记录会写进 ws_sensitive_sites —— 如果设置页正开着不动，列表就会和事实不符。
// 只监听这一个键（别的键与本节无关，重渲染会打断读屏的浏览位置）。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ws_sensitive_sites) return;
  renderSensitiveSites();
});

// ---------- NVDA 设置优化（非侵入式，会话 18：经「循光WennSicht 读屏增强组件」插件） ----------
// 架构：Chrome 扩展沙箱无法直接改写 %APPDATA%\nvda\nvda.ini，也无法向运行中的 NVDA
// 发命令；因此 NVDA 侧装一个只认三键白名单的小插件（仓库 nvda-bridge/），在
// 127.0.0.1:47653 暴露极小端点，扩展经 SW 转发读写（WS_NVDA_BRIDGE_STATUS / _SET）。
// 桥接插件自身不主动改任何设置：只有用户在本页点「一键关闭上述三项」才会写入；
// 三项键名与桥接白名单一一对应（已对 NVDA 官方 configSpec 与本机 nvda.ini 核实）：
//   [speech]         autoLanguageSwitching（自动语言切换（若支持），默认开）
//   [mouse]          enableMouseTracking（启用鼠标导航，默认开）
//   [virtualBuffers] autoSayAllOnPageLoad（页面加载完成后朗读所有内容，默认开）
const NVDA_BRIDGE_ITEMS = [
  ['autoLanguageSwitching', '语音 → 自动语言切换（若支持）'],
  ['enableMouseTracking', '鼠标 → 启用鼠标导航'],
  ['autoSayAllOnPageLoad', '浏览模式 → 页面加载完成后朗读所有内容'],
];
// 2026-10-10（owner）：本区块只回答两件事 —— **NVDA 在不在运行** + **优化完成没有**。
// 原来的「检测 NVDA 桥接 / 一键关闭上述三项 / 复制手动操作说明」三个按钮砍成一个
// 「检测并优化」；术语（桥接插件 / .nvda-addon / nvda.ini 路径 / 手动路径）一律不进界面。

function nvdaBridgeUnreachableText() {
  // 2026-11-03 修：原句「NVDA 未在运行」在「NVDA 在跑、但配套组件没装」时是误导
  //（owner 本机实测：NVDA 便携版在运行、addons 目录为空 ⇒ 连不上）。扩展开不了
  // NVDA 进程列表，两种情况从扩展侧无法区分 ⇒ 如实列出两种可能，不用术语（遵守
  // 2026-10-10 口径：桥接插件 / .nvda-addon 等词不进界面）。
  return '未能连接 NVDA。请先确认 NVDA 已启动；如果还没装配套组件，点下面「安装读屏增强组件」，装完重启一次 NVDA 再点这个按钮。';
}

async function nvdaBridge(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, unreachable: true, error: String(err?.message || err) };
  }
}

// 页面载入 / 优化后都用这一句口径回报：在不在运行 + 优化完成没有。
async function refreshNvdaStatus() {
  const res = await nvdaBridge({ type: 'WS_NVDA_BRIDGE_STATUS' });
  // 会话 54：接不通时才露出「安装读屏增强组件」入口；接通了就收起来，避免多余步骤。
  try {
    const block = $('nvda-install-block');
    if (block) block.hidden = !!res?.ok;
  } catch { /* 老页面没有该块：忽略 */ }
  if (!res?.ok) {
    // 接不通就没什么版本可说：把版本行收起来，不留上一次的旧值
    try { const ver = $('nvda-version'); if (ver) { ver.hidden = true; ver.textContent = ''; } } catch { /* 忽略 */ }
    setStatus('nvda-status', nvdaBridgeUnreachableText());
    return res;
  }
  // 接得通就把「已装组件 x.y.z」直接摆出来（不用用户点按钮才知道装的哪个版本）
  try {
    const ver = $('nvda-version');
    if (ver) {
      ver.hidden = false;
      ver.textContent = `已装组件：${res.bridgeVersion || '未知版本'}`;
    }
  } catch { /* 老页面没有该行：忽略 */ }
  const allOff = NVDA_BRIDGE_ITEMS.every(([key]) => res.settings?.[key] === false);
  setStatus('nvda-status', allOff
    ? 'NVDA 正在运行，已优化完成。'
    : 'NVDA 正在运行，尚未优化——点上面的按钮优化。');
  return res;
}

// 2026-11-11：把「真的去问一次 NVDA」的检查放到设置页，并显示已装组件版本。
// 这个按钮只回答「装没装上 + 装的哪个版本」，不改任何设置。
async function checkAddonInstalled() {
  setStatus('nvda-status', '正在检查是否装好…');
  const res = await nvdaBridge({ type: 'WS_NVDA_BRIDGE_STATUS' });
  const ver = $('nvda-version');
  if (!res?.ok) {
    if (ver) { ver.hidden = true; ver.textContent = ''; }
    setStatus('nvda-status',
      '还未检测到组件。请注意装完需重启 NVDA方可生效；也可以直接在 NVDA 菜单里装：'
      + '工具 → 附加组件商店 →「从外部来源安装…」→选择文件夹中安装包。');
    return false;
  }
  const component = res.bridgeVersion || '未知版本';
  if (ver) {
    ver.hidden = false;
    ver.textContent = `已装组件：${component}`;
  }
  setStatus('nvda-status', `已经装好了：组件 ${component}。`);
  return true;
}

// ---------- 会话 54 + 58：一键拿到读屏增强组件（最轻操作 + 下载失败不卡死） ----------
// owner 2026-11-08：「一定要最轻化用户操作，能少一步是一步，很多用户根本不熟悉技术」。
// 会话 57 真机实证：**刻意不调 chrome.downloads.open()** —— 它同时要求实时用户手势
//（await 下载后手势早已失效）与单独的 "downloads.open" 权限，实测永远失败；
// 改用 downloads.show()（无需手势/额外权限）在列表里选中，用户按一次回车交给 NVDA 安装。
//
// 会话 58：owner 指出「首次下载失败后再点会被 Chrome 改成 (1) 之类的文件名」，要求
// 「下载自动失败 / 暂停 / 任何原因都不能卡住」。本版策略：
//   ① 已有 complete 且文件还在 → **直接复用**，不再下载（不会再出现 (1)）；
//   ② 已有 in_progress / paused → 恢复（resume）并等它完成，不另起一个；
//   ③ interrupted → 清掉这条记录与残片，再用 conflictAction:'overwrite' 重下一次；
//   ④ 轮询 + onChanged 双保险，硬超时 15 秒，绝不无限等；任何异常都给明确文案并解锁按钮。
const NVDA_ADDON_PATH = 'nvda/WennSicht-nvda-bridge-v1.3.3.nvda-addon';
const NVDA_ADDON_NAME = 'WennSicht-nvda-bridge-v1.3.3.nvda-addon';
const ADDON_DL_TIMEOUT = 15000;

// 2026-11-11：下载完只说这一步要做的事；少数机器上「按回车」会弹系统选择框——那条兜底
// 由 checkAddonInstalled() 在「确实没装上」时才给（见下面的失败文案），不预先塞进成功提示里。

// ---------- 会话 72 终版（2026-11-14 15:19 · owner 新方案：先播完，再下载） ----------
// owner 定案：**点按钮当场开始播报，整句念完之后才真正发起下载**。
// 这样「下载太快 ⇒ 播报还没念完就被下载文件夹抢走」从根上不可能发生：
// 下载动作排在整句念完之后，播报期间页面上不存在任何抢焦点或抢播报的动作。
// ① 点击 → assertive 写入定稿整句（焦点留在本页）
// ② 播报保护窗口（按字数）结束 → 才 chrome.downloads.download()
// ③ 下载完成（或复用已有完整文件）→ chrome.downloads.show(id) 自动打开下载文件夹并选中文件
// ④ 失败 → 只播报失败原因，不打开文件夹（不让文件夹内容把失败说明顶掉）
// ⚠️ preparing 为 owner 2026-11-14 15:19 **逐字定稿**，agent 不改字；改字只动这个常量对象。
const NVDA_ADDON_GUIDE = {
  preparing: '正在准备下载。下载完后，文件会自动选中，请按回车打开，根据弹窗导览完成安装并重启NVDA。完成后回到这里点「检测并优化」。',
  timeout: '下载超时了，请重试。',
  interrupted: '下载意外中断，请重试。',
};
// 中文 NVDA 默认约 4–5 字/秒 ⇒ 220ms/字 保守估计「整句念完」所需时间；下限 4s、上限 18s。
// 这一段是**听播报的时间**，不是空等：窗口结束才开始下载，下载完文件夹刚好弹出。
// 仅诊断/回归可由 window.__WS_GUIDE_HOLD_MS__ 覆盖（dev 钩子，不改变用户可见行为）。
function guideHoldMs(text) {
  const override = Number(window.__WS_GUIDE_HOLD_MS__);
  if (Number.isFinite(override) && override >= 0) return override;
  return Math.min(18000, Math.max(4000, String(text).length * 220));
}
let nvdaHoldTimer = null;

function restoreAddonLiveRegion() {
  try { const s = $('nvda-status'); if (s) s.setAttribute('aria-live', 'polite'); } catch { /* 忽略 */ }
}
// 把整句念完：写入 assertive 播报源，窗口结束才 resolve —— 调用方在此之前**不得发起下载**。
function announceBeforeDownload(text) {
  return new Promise((resolve) => {
    const status = $('nvda-status');
    try { if (status) status.setAttribute('aria-live', 'assertive'); } catch { /* 忽略 */ }
    // 先清空再写入：同一句（重复点击/重试）也能被念出来。
    if (status) status.textContent = '';
    setTimeout(() => { if (status) status.textContent = text; }, 60);
    if (nvdaHoldTimer) clearTimeout(nvdaHoldTimer);
    nvdaHoldTimer = setTimeout(() => { nvdaHoldTimer = null; resolve(); }, guideHoldMs(text));
  });
}
// 失败说明同样要听得见：不再 show()，直接把原因念出来。
function announceAddonFailure(text) {
  const status = $('nvda-status');
  try { if (status) status.setAttribute('aria-live', 'assertive'); } catch { /* 忽略 */ }
  if (status) status.textContent = '';
  setTimeout(() => { if (status) status.textContent = text; }, 60);
  setTimeout(restoreAddonLiveRegion, 15000);
}
// 全页唯一允许抢焦点的地方：只在下载完成之后调用（此时整句早已念完）。
async function showAddonFile(id) {
  restoreAddonLiveRegion();
  try { await chrome.downloads.show(id); } catch { /* 打不开也已有文字指路 */ }
}

// 只认本扩展自己发起的、文件名是本安装包（含历史 (1) 变体）的下载；
// 绝不遍历/删除用户其它下载记录（会话 57 事故教训）。
function isOwnAddonDownload(d) {
  return d.byExtensionId === chrome.runtime.id
    && /WennSicht-nvda-bridge[^\\/]*\.nvda-addon/i.test(String(d.filename || ''));
}
async function ownAddonDownloads() {
  const all = await chrome.downloads.search({});
  return all.filter(isOwnAddonDownload);
}
async function forgetAddonDownload(id) {
  try { await chrome.downloads.removeFile(id); } catch { /* 文件可能已不在 */ }
  try { await chrome.downloads.erase({ id }); } catch { /* 记录可能已不在 */ }
}
// 等下载落定：onChanged + 轮询双保险；paused 自动 resume；interrupted/超时返回原因，绝不挂住。
function waitAddonDownload(id) {
  return new Promise((resolve) => {
    let settled = false;
    let poll = null;
    let timer = null;
    let onChanged = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (onChanged) chrome.downloads.onChanged.removeListener(onChanged);
      resolve(v);
    };
    const inspect = async () => {
      try {
        const arr = await chrome.downloads.search({ id });
        const d = arr && arr[0];
        if (!d) { finish({ ok: false, why: 'vanished' }); return; }
        if (d.state === 'complete') { finish({ ok: true, id }); return; }
        if (d.state === 'interrupted') { finish({ ok: false, why: 'interrupted', id }); return; }
        if (d.paused) { try { await chrome.downloads.resume(id); } catch { /* 继续轮询 */ } }
      } catch { /* 单次查询失败不终止整个等待 */ }
    };
    onChanged = (delta) => {
      if (delta.id !== id) return;
      const s = delta.state?.current;
      if (s === 'complete') finish({ ok: true, id });
      else if (s === 'interrupted') finish({ ok: false, why: 'interrupted', id });
      else if (delta.paused?.current === true) {
        try { chrome.downloads.resume(id); } catch { /* 忽略 */ }
        inspect();
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    poll = setInterval(inspect, 350);
    timer = setTimeout(() => finish({ ok: false, why: 'timeout', id }), ADDON_DL_TIMEOUT);
    inspect(); // 立刻查一次（下载可能已经完成，onChanged 早于监听注册）
  });
}

async function installNvdaAddon() {
  // 会话 72：播报中 / 下载中再点一次，直接忽略（不重新下载、不重置窗口、不抢焦点）。
  if (nvdaPhase !== 'idle') return;
  const btn = $('nvda-install');
  try { if (btn) btn.disabled = true; } catch { /* 忽略 */ }

  // ① 先把整句念完 —— 此刻还没有任何下载动作，所以不可能被下载文件夹抢断。
  nvdaPhase = 'announcing';
  await announceBeforeDownload(NVDA_ADDON_GUIDE.preparing);

  // ② 念完之后才真正开始下载。
  nvdaPhase = 'downloading';
  let targetId = null;
  try {
    const own = await ownAddonDownloads();

    // ① 已有的完整下载直接复用（含文件名带 (1) 的旧记录），不再产生新文件
    const reusable = own.find((d) => d.state === 'complete' && d.exists !== false);
    if (reusable) {
      targetId = reusable.id;
    } else {
      // ② 进行中 / 暂停 → 恢复并等它，不另起下载
      const running = own.find((d) => d.state === 'in_progress' || d.paused);
      if (running) {
        targetId = running.id;
        if (running.paused) { try { await chrome.downloads.resume(running.id); } catch { /* 忽略 */ } }
        const r = await waitAddonDownload(running.id);
        if (!r.ok) {
          await forgetAddonDownload(running.id);
          targetId = null;
        }
      }
      // ③ 失败的残片清掉，再重下一次；conflictAction:'overwrite' 保证文件名稳定
      if (targetId === null) {
        // interrupted 残片 / 文件已不存在的旧记录都清掉，避免 overwrite 撞上旧记录
        for (const stale of own.filter((d) => d.state === 'interrupted' || (d.state === 'complete' && d.exists === false))) {
          await forgetAddonDownload(stale.id);
        }
        const url = chrome.runtime.getURL(NVDA_ADDON_PATH);
        let id = null;
        try {
          id = await chrome.downloads.download({
            url, filename: NVDA_ADDON_NAME, saveAs: false, conflictAction: 'overwrite',
          });
        } catch (firstErr) {
          // overwrite 可能因为目标文件被占用而失败：先清掉同名旧记录再试一次
          const again = await ownAddonDownloads();
          for (const d of again) await forgetAddonDownload(d.id);
          try {
            id = await chrome.downloads.download({
              url, filename: NVDA_ADDON_NAME, saveAs: false, conflictAction: 'uniquify',
            });
          } catch (secondErr) {
            throw new Error('下载未能开始：' + String(secondErr?.message || firstErr));
          }
        }
        if (typeof id !== 'number') throw new Error('下载未开始');
        const r = await waitAddonDownload(id);
        if (!r.ok) {
          announceAddonFailure(r.why === 'timeout' ? NVDA_ADDON_GUIDE.timeout : NVDA_ADDON_GUIDE.interrupted);
          return;
        }
        targetId = id;
      }
    }

    // ③ 下载完成 → 打开下载文件夹并选中文件（用户已听完指引，此时切焦点不会掐断任何播报）
    await showAddonFile(targetId);
  } catch (err) {
    announceAddonFailure('安装包没能下载：' + String(err?.message || err).slice(0, 70)
      + '。按钮已经恢复，可以再点一次。');
  } finally {
    nvdaPhase = 'idle';
    try { if (btn) btn.disabled = false; } catch { /* 忽略 */ }
  }
}

// 一键优化（这就是产品功能本体）：只关闭白名单三键，逐键写后读回，终态再校验一遍；
// 任何一步失败都不谎报成功。
async function optimizeNvdaSettings() {
  setStatus('nvda-status', '正在优化…');
  const st = await nvdaBridge({ type: 'WS_NVDA_BRIDGE_STATUS' });
  if (!st?.ok) {
    setStatus('nvda-status', nvdaBridgeUnreachableText());
    return;
  }
  for (const [key] of NVDA_BRIDGE_ITEMS.filter(([k]) => st.settings?.[k] === true)) {
    const r = await nvdaBridge({ type: 'WS_NVDA_BRIDGE_SET', key, value: false });
    if (!r?.ok) {
      setStatus('nvda-status', '优化未完成，请重试。');
      return;
    }
  }
  // 终态读回：确认三项真的都关着，再报结果（读不回也不谎报成功）
  const final = await nvdaBridge({ type: 'WS_NVDA_BRIDGE_STATUS' });
  const allOff = final?.ok && NVDA_BRIDGE_ITEMS.every(([key]) => final.settings?.[key] === false);
  setStatus('nvda-status', allOff ? '已优化完成。' : '优化未完成，请重试。');
}

$('nvda-optimize').addEventListener('click', () => { optimizeNvdaSettings(); });
try {
  $('nvda-install')?.addEventListener('click', () => { installNvdaAddon(); });
} catch { /* 老页面无该按钮：忽略 */ }
try {
  $('nvda-check')?.addEventListener('click', () => { checkAddonInstalled(); });
} catch { /* 老页面无该按钮：忽略 */ }

// 「复制手动操作说明」按钮已删除（owner 2026-10-10）：面向视障用户，让他们照着一串
// NVDA 菜单路径手动改设置，等于把该做的事又推回给用户；一键优化才是这个区块存在的意义。

// ---------- 渲染 ----------
async function renderSites() {
  const { ws_sites = {} } = await chrome.storage.local.get('ws_sites');
  const list = $('site-list');
  list.textContent = '';
  const origins = Object.keys(ws_sites).sort();
  $('sites-empty').hidden = origins.length > 0;
  for (const origin of origins) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = '移除';
    btn.setAttribute('aria-label', '移除 ' + origin);
    btn.addEventListener('click', () => removeSite(origin));
    li.append(name, btn);
    list.append(li);
  }
  await syncSitesModeUi();
}

// 「二、在哪些网站启用」的当前状态行。
// 目的（owner 2026-10-10 反馈）：全局启用与添加站点是并列的两个选项，设好一条另一条就没必要再动。
// 与其把这句话写成说明，不如直接把「现在哪一条在生效、另一条的适用范围是否已被涵盖」读出来。
async function syncSitesModeUi() {
  const el = $('sites-mode');
  if (!el) return;
  // 与 init() 同口径：真相是 storage 的 ws_global，再与真实权限做「与」。
  // （关全局后我们刻意保留 <all_urls>，只看权限会把已关闭的全局误读成「已全局启用」。）
  const { ws_global: storedGlobal = false, ws_sites = {} } = await chrome.storage.local.get([
    'ws_global',
    'ws_sites',
  ]);
  let hasGlobalPerm = false;
  try {
    hasGlobalPerm = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    hasGlobalPerm = false;
  }
  const hasGlobal = storedGlobal === true && hasGlobalPerm;
  const n = Object.keys(ws_sites).length;
  // 列表为空时，空态文案也要跟着状态走：已全局启用时说「尚未启用任何站点」是错的。
  const empty = $('sites-empty');
  if (empty && n === 0) {
    if (hasGlobal) {
      empty.textContent = '这里只列您逐个添加的站点；本机已全局启用，列表为空属正常。';
    } else {
      // 会话 79：必须保留占位符（data-ws-key="toggle"）。旧写法整段 textContent 覆盖，
      // 会把 HTML 里的占位符 <span data-ws-key="toggle"> 一起冲掉 ⇒ applyShortcutText()
      // 之后再也改不到这句，用户换键后这里仍显示旧键（verify-shortcut-copy 断言 8 处占位符）。
      empty.textContent = '尚未启用任何站点。先按上面两条做法之一设置，再到该网站按 ';
      const key = document.createElement('strong');
      key.dataset.wsKey = 'toggle';
      key.textContent = TOGGLE_KEY;
      empty.appendChild(key);
      empty.appendChild(document.createTextNode(' 开启增强。'));
    }
  }
  if (hasGlobal) {
    el.textContent = n > 0
      ? `当前状态：已全局启用，整个浏览器都会生效；第一条的适用范围已经把您单独添加的 ${n} 个站点涵盖在内。`
      : '当前状态：已全局启用，整个浏览器都会生效；第二条「添加站点」的适用范围已经被它涵盖。';
  } else if (n > 0) {
    el.textContent = `当前状态：已按站点启用 ${n} 个网站。想覆盖更多网站时，再考虑第一条「全局启用」。`;
  } else {
    el.textContent = '当前状态：两条都还没设，增强目前不会自动在任何网站上生效。';
  }
}

async function init() {
  // 同步全局开关的 UI 状态。
  // 2026-10-10（owner 口径：ws_sites 列表永远保存，全局只是覆盖开关）：
  //   状态真相 = storage 的 ws_global，**不再**是「手上有没有 <all_urls> 授权」。
  //   为什么必须改：关闭全局时不能再去 permissions.remove(<all_urls>) —— 它按**包含语义**
  //   匹配 pattern，会把「添加站点」列表里各站点的可选 host 授权一并**永久**清掉（连重载都
  //   回不来），「全局 toggle on→off 后恢复列表」就无从实现。既然不再撤销授权，授权就不能
  //   再当作开关状态，否则下次打开设置页会把开关自动勾回去、ws_global 被覆写回 true。
  //   仍与真实权限做「与」运算：用户若在浏览器设置里手动撤销全站授权，这里要如实反映为关闭。
  let hasGlobalPerm = false;
  try {
    hasGlobalPerm = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    hasGlobalPerm = false;
  }
  const { ws_global: storedGlobal = false } = await chrome.storage.local.get('ws_global');
  const globalOn = storedGlobal === true && hasGlobalPerm;
  $('global-toggle').checked = globalOn;
  if (globalOn !== (storedGlobal === true)) {
    // 只在不一致时写回（授权被外部撤销 → 如实置 false）
    await chrome.storage.local.set({ ws_global: globalOn });
  }

  // 载入大模型接口配置（刻意不含密钥 —— 密钥只显示「是否已保存」）。
  // 显示层兼容旧槽名与平铺结构（SW 的正式迁移会在下次 AI 调用时落盘）：
  //   primary ← primary ?? main；default ← default ?? back ?? 平铺字段
  const aiCfg = await readStoredAiConfig();
  const primaryCfg = aiCfg.primary ?? aiCfg.main ?? {};
  const defaultCfg = aiCfg.default ?? aiCfg.back ?? {};
  const flat = {
    baseUrl: aiCfg.baseUrl || '',
    textModel: aiCfg.textModel || '',
    visionModel: aiCfg.visionModel || '',
    decisionModel: aiCfg.decisionModel || aiCfg.jevModel || '', // 后者＝升级前的旧字段名
  };
  // 公益中转（2026-10-07）：先取状态再定「接口来源」radio。
  // radio 默认值：存储 provider 明确 → 按存储；无存储（出厂）→ 构建内置端点即公益中转、
  // 否则自定义；存储为公益中转但端点已不可用 → 回退自定义并提示。
  await refreshRelayStash(false);
  const hasCustomContent = !!(primaryCfg.baseUrl || defaultCfg.baseUrl || flat.baseUrl
    || primaryCfg.textModel || defaultCfg.textModel || flat.textModel);
  let provider = aiCfg.provider || (relayStash.configured && !hasCustomContent ? 'builtin-relay' : 'openai-compatible');
  if (provider === 'builtin-relay' && !relayStash.configured) {
    provider = 'openai-compatible';
    setStatus('ai-status', '此前使用公益中转，但当前构建未内置端点，已回退到「使用自己的接口」模式（参数需重新填写）。');
  }
  const sourceValue = provider === 'builtin-relay' ? 'builtin' : 'custom';
  const sourceRadio = document.querySelector(`input[name="ai-source"][value="${sourceValue}"]`);
  if (sourceRadio) sourceRadio.checked = true;
  savedProvider = provider; // 已保存来源：决定密钥金库一节是否显示（见 syncVaultSectionUi）
  $('ai-primary-baseurl').value = primaryCfg.baseUrl || '';
  $('ai-primary-textmodel').value = primaryCfg.textModel || '';
  $('ai-primary-visionmodel').value = primaryCfg.visionModel || '';
  $('ai-default-baseurl').value = defaultCfg.baseUrl || flat.baseUrl || '';
  $('ai-default-textmodel').value = defaultCfg.textModel || flat.textModel || '';
  $('ai-default-visionmodel').value = defaultCfg.visionModel || flat.visionModel || '';
  // 显示层读的是**原始存储**（不经过 SW 迁移）：旧字段名 jevModel 必须一并认，
  // 否则升级后打开设置页会看到决策模型栏像是配置丢了。
  // 2026-11-15 owner 定案：不再补 typesafe/jev-1.13——决策模型必填，空就显示空，
  // 让用户看见「这里没配」而不是被一个不是他填的模型名糊住（下次保存会要求补齐）。
  $('ai-default-decisionmodel').value = defaultCfg.decisionModel || defaultCfg.jevModel || flat.decisionModel || '';
  if (provider === 'builtin-relay') {
    // 公益中转模式下自定义字段留空：中转预配（别名）不是自定义参数，
    // 留着会让「切回自己的接口」时误把中转地址当自定义配置提交
    for (const id of ['ai-primary-baseurl', 'ai-primary-textmodel', 'ai-primary-visionmodel',
      'ai-default-baseurl', 'ai-default-textmodel', 'ai-default-visionmodel', 'ai-default-decisionmodel']) {
      $(id).value = '';
    }
  }
  $('ai-primary-apikey').value = ''; // 永不回显密钥
  $('ai-default-apikey').value = '';
  applySourceUi();

  // 公益中转的接口配置从来没被保存过（2026-11-03 owner 实测：
  // `{enabled:true, hasDefaultKey:false, hasPrimaryKey:false}` —— 只有开关，没有 default 槽）。
  // 为什么漏：公益中转模式下 `ai-custom-actions`（含「保存」按钮）是收起的，用户根本没有
  // 地方点保存；而内容脚本读**原始存储**，没有 default 槽就判「没有文本模型」，
  // 页面于是永远播「请先配置文本模型」。这里补写一次，与 SW 侧迁移同一口径。
  if (provider === 'builtin-relay' && relayStash.preset
    && !aiCfg.default && !aiCfg.back && !aiCfg.baseUrl && !aiCfg.textModel
    && !aiCfg.primary?.baseUrl && !aiCfg.primary?.textModel) {
    await WS_AI_CONFIG_SAVE({
      provider: 'builtin-relay',
      primary: { baseUrl: '', textModel: '', visionModel: '', reasoning: {} },
      default: relayStash.preset,
    });
  }

  await renderKeyState();
  await renderLastVerify();

  // 载入图片描述设置
  const { ws_image_config = {} } = await chrome.storage.local.get('ws_image_config');
  // 主开关（2026-11-03 修）：显示口径必须与内容脚本的 WS_AI_SLOTS.enabled() 一致。
  // 存储里是布尔就照它；没写（出厂 / 旧版本从未保存过这一项）则按「公益中转就位或
  // 已存过接口配置」显示为开启——并把结论**落盘**，否则内容脚本读原始存储时
  // 会把「界面勾着」判成关闭，页面反复播「请先在设置页启用…」（0.2.0 实锤）。
  const masterOn = typeof aiCfg?.enabled === 'boolean'
    ? aiCfg.enabled
    : (provider === 'builtin-relay' || !!defaultCfg.baseUrl || !!flat.baseUrl || relayStash.configured);
  $('ai-master').checked = masterOn;
  if (typeof aiCfg?.enabled !== 'boolean') {
    WS_AI_CONFIG_SAVE({ enabled: masterOn }).catch(() => {});
  }
  // 2026-11-10：上限开关。缺省（老数据）按 dailyLimit>0 推断 ⇒ 已有用户行为不变
  const imgLimitOn = ws_image_config.limitEnabled === true
    || (ws_image_config.limitEnabled == null && Number(ws_image_config.dailyLimit) > 0);
  $('img-limit-on').checked = imgLimitOn;
  $('img-limit').value = String(
    Number(ws_image_config.dailyLimit) >= 0 ? Number(ws_image_config.dailyLimit) : 100
  );
  syncImgLimit();
  $('hover-replay').checked = !!ws_image_config.hoverReplay; // 悬停重听（默认关）
  await renderUsage();

  await renderVaultState(); // 金库状态（锁定/解锁/待设置主密码）

  // 载入浏览便利功能偏好（位置记忆默认开）
  const { ws_ui_config = {} } = await chrome.storage.local.get('ws_ui_config');
  $('position-memory').checked = ws_ui_config.positionMemory !== false;
  $('announce-changes').checked = ws_ui_config.announceChanges !== false; // 默认开（2026-10-31）

  await renderSensitiveSites(); // 敏感站点保护列表（v0.2 第 8 项）
  await renderLiveSites(); // 动态变化播报站点列表（v0.2 第 10 项，默认关）

  refreshNvdaStatus(); // NVDA 在不在运行 / 优化完成没有（不 await：NVDA 未运行时不阻塞其它渲染）

  await renderSites();
  refreshKeyBindings(); // 快捷键绑定状态提醒（v0.2 收尾：新功能键无默认绑定）
}

// ---------- 快捷键绑定状态提醒（v0.2 收尾） ----------
// page-qa / image-longdesc / layout-map 三个新功能没有默认按键（Chrome 上限 4 个
// 带默认键的命令），必须由用户在 chrome://extensions/shortcuts 手动绑定一次——
// 盲用户无法自己发现「某个功能按键按了没反应=没绑定」，设置页主动点名提醒。
// 从快捷键管理页回到设置页时（window focus）自动重查，绑定完提醒即消失。
// 功能名用大白话，方便和用户实际听到的功能对上。
const KEY_LABELS = {
  'toggle-wennsicht': '开启 / 关闭增强',
  'pause-image-description': '暂停图片描述',
  'send-feedback': '一键反馈',
  'page-summary': '页面结构摘要',
  'page-qa': '页面问答',
  'image-longdesc': '图片长描述',
  'layout-map': '布局地图',
  // 2026-10-11（owner）：把 Chrome 内置的 `_execute_action` 也纳入清单。
  // 它在 Chrome 快捷键页里显示为「启用扩展程序 / Activate the extension」，**是可绑键的真实命令**
  // （旧注释说「永远绑不了」是错的）；按它 = 触发 `chrome.action.onClicked`
  // （见 service-worker.js）→ `openOptionsPage()`，也就是「一键把本扩展打开」。
  // 这条对盲用户价值尤其大：工具栏图标用鼠标点得到、键盘用户却点不到，
  // 绑一个键就等于给扩展界面补了一条纯键盘入口。**必须给标签**——`getAll()` 里它的
  // `description` 是**空串**，不给就会在列表里露出 `_execute_action` 这种内部名。
  '_execute_action': '打开扩展设置（相当于点工具栏图标）',
};
// 2026-10-10（owner）：① 不再写「在地址栏输入 chrome://extensions/shortcuts」——入口做成一键按钮，
//   常显（此前只在"有未绑定项"时才显示，等于大部分时候用户看不到入口）。
//   实测扩展页经 chrome.tabs.create 可以可靠打开 chrome:// 页（普通网页里的 chrome:// 链接会被拦）。
// ② 不再只列"未绑定的那几个"，而是把**全部**功能连**当前实际绑定**一起列出来——
//   用户本来就不知道默认键是什么，只列缺的等于让他猜。
// ③ 无法在本页直接改键：实测 chrome.commands.update 在本扩展里是 undefined（普通安装未开放），
//   所以"就地绑定"只能用按钮跳到 Chrome 的快捷键页；跳回来时 window focus 会自动重查。
// ④ 2026-10-11（owner）：**清单里必须包含 Chrome 内置的 `_execute_action`**
//   （快捷键页显示为「启用扩展程序」）。它是可绑键的真实命令，按它 = 点工具栏图标 = 打开设置页，
//   等于给键盘/读屏用户补了一条纯键盘入口。旧代码把它滤掉，导致用户绑好键后在本页查不到。
function refreshKeyBindings() {
  const status = document.getElementById('keys-status');
  const list = document.getElementById('keys-list');
  const openBtn = document.getElementById('keys-open');
  if (!status || !list) return;

  if (openBtn && !openBtn.dataset.wired) {
    openBtn.dataset.wired = '1';
    openBtn.addEventListener('click', () => {
      try {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
      } catch (e) {
        console.warn('[WennSicht] 打开快捷键设置页失败：', e);
      }
    });
  }

  chrome.commands.getAll((commands) => {
    // 2026-10-11（owner）：**不再排除 `_execute_action`**。
    //   旧注释写它是「点工具栏图标」的伪命令、「永远绑不了」——**后半句是错的**：Chrome 允许给它绑键，
    //   owner 已实机把 Ctrl+Shift+I 绑上（`dev/_probe-commands.mjs` 实测 `getAll()` 第 1 条
    //   就是 `{name:'_execute_action', shortcut:'Ctrl+Shift+I', description:''}`）。
    //   藏掉它的后果很糟：用户在 Chrome 快捷键页明明绑好了，回到设置页却查不到这一项，
    //   会以为「没生效 / 我记错了」——**看不见的绑定比没绑更伤人**。
    //   只有真正不存在于 `getAll()` 的东西才该被过滤；这里现在**一条都不滤**。
    const cmds = (commands || []).slice();
    list.textContent = '';
    const unboundNames = [];
    for (const c of cmds) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      const label = KEY_LABELS[c.name] || c.description || c.name;
      name.textContent = label;
      const key = document.createElement('strong');
      if (c.shortcut) {
        key.textContent = c.shortcut;
      } else {
        key.textContent = '未绑定';
        key.className = 'key-unbound';
        unboundNames.push(label);
      }
      li.append(name, key);
      list.appendChild(li);
    }
    // 2026-10-11（owner 当场抓出「自相矛盾」）：状态行**必须与列表逐项一致**。
    // 我先前把内置的「打开扩展设置」排除在计数之外（理由是它只是进设置页的捷径、
    // 缺了不影响任何功能可用）—— 结果是**列表里明晃晃一行「未绑定」，状态行却说
    // 「全部功能都有按键」**。用户看到的是一句假话，比多一句提醒糟得多。
    // 现在**计数只看列表**：只要有一行显示「未绑定」，状态行就必须承认。
    // 措辞用「项」而非「功能」（列表里除了功能还有「打开扩展设置」这一项），
    // 并**点名缺哪些** —— 读屏用户只看数字不知道要绑什么。
    // 用冒号引出清单、**不再套一层括号**：标签本身含「（相当于点工具栏图标）」，
    // 再括一层会读成「（打开扩展设置（相当于…））」这种嵌套括号，听感很差。
    status.textContent = unboundNames.length
      ? `还有 ${unboundNames.length} 项没有按键：${unboundNames.join('、')}，用键盘触发不了。点下面的按钮去分配。`
      : '全部功能都有按键，可直接使用。';
  });
}
window.addEventListener('focus', refreshKeyBindings); // 从快捷键页回来时自动重查


// ---------- 会话 56：独立引导页的小重访入口 ----------
// 首次使用引导已移到 src/welcome/welcome.html（首次安装自动打开、一次性）。
// 设置页**只**留这个按钮：点一下重新走一遍，不自动出现、不内嵌任何引导内容。
// 不读写 ws_welcome_done —— 重访是用户主动的，不该把「已完成」标记清掉。
document.addEventListener('DOMContentLoaded', () => {
  $('welcome-retour')?.addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
    } catch (err) {
      console.warn('[WennSicht] 打开使用引导失败:', err);
    }
  });
});

document.addEventListener('DOMContentLoaded', init);
