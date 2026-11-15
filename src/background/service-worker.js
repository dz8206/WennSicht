// WennSicht 控制层（Service Worker）
// 职责（BP 2.2）：快捷键路由、徽标状态、打开设置页、大模型调用路由。
// 铁律：本文件不做推理、不保存全局可变状态（MV3 SW 随时可能被终止，
//       所有持久状态都在 chrome.storage；技能规则 7）。

importScripts('/src/data/content-files.js');
importScripts('/src/services/key-vault.js');
// 密钥保管：2026-09-30 起改用 WebCrypto 金库（API加密本地储存.docx 方案）。
// WS_SECRETS 名字保留指向金库封装（ai.js 零改动）；旧 DPAPI 宿主的 secret-store.js
// 仅作迁移源保留在 dev 目录文档中，不再被 SW 加载。
const WS_SECRETS = globalThis.WS_KEYVAULT;
// 公益中转接入层（2026-10-07 会话 20）：必须在 ai.js 之前加载——
// ai.js 的出厂预配读取 WS_RELAY.ENDPOINT_DEFAULT/ALIASES，builtin-relay
// provider 的设备令牌请求头也由它提供。
importScripts('/src/services/relay.js');
importScripts('/src/services/ai.js');
importScripts('/src/services/vision.js');

// storage.session 放开给内容脚本（2026-11-03 会话 45）：框架级块 gather 的交接面——
// 子框架把本框架的块节选写进来，顶层问答读取合并。默认只有受信上下文（扩展页/SW）能写。
// 注意参数名是 accessLevel（写成 level 会 reject「Unexpected property」且同步 try/catch
// 捕不到 Promise 拒绝——探针 P6 曾因此静默全灭）。
try {
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => { /* 旧版本 Chrome 无此 API：gather 静默降级为只有顶层块 */ });
} catch { /* 同上 */ }

const BADGE_ON = '开';
const BADGE_OFF = '关';
const BADGE_UNAVAILABLE = '✕'; // 站点未启用 / 页面被排除，无法处理

// ---------- 内容脚本注册自愈 ----------
// 根因（2026-09-27 实测）：chrome.runtime.reload()（扩展重载/更新）会清除
// 动态注册的内容脚本（DYNAMIC_CONTENT_SCRIPT），persistAcrossSessions 只
// 保浏览器会话。结果：扩展每次更新后页面上没有内容脚本，快捷键全部红 ✕。
// 自愈策略：SW 每次冷启动时按 storage 记录重建/同步/清理注册——
//   缺失 → 重建；js 清单过时 → 更新；storage 已删 → 注销。
// 这同时覆盖了开发期自动重载与正式版扩展更新两种场景。
async function ensureRegistrations() {
  const files = globalThis.WS_CONTENT_FILES;
  if (!files?.length) return;

  const { ws_global = false, ws_sites = {} } = await chrome.storage.local.get([
    'ws_global',
    'ws_sites',
  ]);

  // storage 期望的注册表：id → matches
  const expected = new Map();
  if (ws_global) {
    expected.set(globalThis.WS_GLOBAL_SCRIPT_ID, ['<all_urls>']);
  }
  for (const origin of Object.keys(ws_sites)) {
    expected.set(globalThis.WS_siteScriptId(origin), [origin + '/*']);
  }

  let existing;
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (err) {
    console.warn('[WennSicht] 读取内容脚本注册失败:', err);
    return;
  }

  const actual = new Map(); // 去掉 `_dc_` 前缀后的 id → 原始注册
  for (const s of existing) {
    if (!globalThis.WS_isOwnScriptId(s.id)) continue;
    actual.set(s.id.replace(/^_dc_/, ''), s);
  }

  // 1) 重建缺失 / 更新过时的
  for (const [id, matches] of expected) {
    const cur = actual.get(id);
    const jsSame =
      cur && Array.isArray(cur.js) && cur.js.length === files.length &&
      files.every((f, i) => cur.js[i] === f) &&
      cur.allFrames === true; // v0.2：同源 iframe 也要注入，旧注册需迁移
    if (jsSame) continue;
    try {
      if (cur) {
        // v0.2：连同 allFrames 一起更新，把历史注册迁移到「含同源子框架」
        await chrome.scripting.updateContentScripts([{ id: cur.id, js: files, allFrames: true }]);
        console.log('[WennSicht] 已更新内容脚本注册:', id);
      } else {
        await chrome.scripting.registerContentScripts([
          { id, matches, js: files, runAt: 'document_idle', allFrames: true },
        ]);
        console.log('[WennSicht] 已重建内容脚本注册:', id);
      }
    } catch (err) {
      // 常见于用户在浏览器设置里撤销了对应 origin 权限
      console.warn('[WennSicht] 注册失败（权限可能已撤销）:', id, err);
    }
  }

  // 2) 清理 storage 已不存在的注册
  for (const [id, cur] of actual) {
    if (expected.has(id)) continue;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [cur.id] });
      console.log('[WennSicht] 已注销过期注册:', id);
    } catch {
      // 忽略
    }
  }
}

ensureRegistrations();

// ---------- 会话 69 · 已打开标签的「孤立上下文」自愈重注入 ----------
// 根因（dev/probe-invalidated-context.mjs 严格对照实证）：扩展重载 / CWS 自动更新后，
// 动态注册重建只影响**之后新打开**的页面；**此前已打开**的真实站点标签里，旧内容脚本
// 的隔离世界还在（window.__WS_LOADED__=true、21 个 WS_* 模块都在），但 chrome.runtime.id
// 变 undefined、storage/sendMessage 全抛 "Extension context invalidated." ⇒
// 看起来装好了、实际全废。实测 sendMessage 从「有接收端」变成
// "Could not establish connection. Receiving end does not exist."，
// 而 executeScript(files=27 个内容脚本) 后通信与模块全部恢复。
//
// 对策：SW 每次冷启动（含 update / dev reload）对已打开的 http(s) 标签做一次**探测 + 补注入**。
//   · 探测用 sendMessage 的轻量 WS_PING：有接收端 ⇒ 健康，不动；收不到 ⇒ 补注入。
//   · 只处理 http(s)：chrome:// / 扩展页 / 商店 / 敏感清单页面一律跳过。
//   · 补注入前先清旧世界的 __WS_LOADED__（content.js 的哨兵已允许失效世界让位），
//     避免 27 个脚本被幂等守卫全部 early-return。
//   · 全程 try/catch + 单标签独立，任何一个标签失败不影响其余；零人为等待。
// ⚠️ 不能对每个标签都无条件注入：健康页重复注入会造成双份监听器/重复播报。
// ⚠️ 只在「本轮 SW 生命周期」跑一次（模块级 flag）；MV3 SW 可能反复唤醒。
let wsHealDone = false;
async function healInvalidatedTabs() {
  if (wsHealDone) return;
  wsHealDone = true;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  } catch { return; }
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    if (!tab || typeof tab.id !== 'number') continue;
    const tabId = tab.id;
    try {
      // ① 探测：直接在目标隔离世界读 **chrome.runtime.id**。
      //    ⚠️ 不能用 sendMessage 判活：孤立世界里残留的 onMessage 监听器仍可能回包
      //    （实测 reload 后旧世界还能响应），会误判「健康」；而 chrome.runtime.id
      //    是 Chrome 亲自给出的上下文存活性判据（失效时恒为 undefined）——
      //    这也是 dev-env.mjs::findLiveIsoWorld 用的同一把尺子。
      let alive = false;
      try {
        const probe = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              return {
                rid: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : null,
                loaded: window.__WS_LOADED__ === true,
              };
            } catch { return { rid: null, loaded: false }; }
          },
        });
        const r = Array.isArray(probe) ? probe[0]?.result : null;
        // 有有效 runtime.id 且脚本已装载 ⇒ 健康，绝不重复注入（重复注入会撞
        // noise-cleaner / landmarks 的顶层声明，实测 SyntaxError）。
        alive = !!(r && r.rid && r.loaded);
      } catch { alive = false; }
      if (alive) continue;
      // ② 只给「本扩展确实启用过」的站点补注入，避免打扰用户没开的页面。
      //    读不到存储（极端情况）时按全局开启兜底 ⇒ 宁可多注入也不让已开启站点残废。
      let enabled = true;
      try {
        const s = await chrome.storage.local.get(['ws_global', 'ws_active_sites', 'ws_sites']);
        const origin = (() => { try { return new URL(tab.url).origin; } catch { return ''; } })();
        enabled = s.ws_global === true
          || s.ws_active_sites?.[origin] === true
          || !!s.ws_sites?.[origin];
      } catch { /* 保持兜底 true */ }
      if (!enabled) continue;
      // ③ 清旧世界的幂等标记 + 补注入全部内容脚本
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            try { delete window.__WS_LOADED__; } catch {}
            try { window.__WS_CTX_ALIVE__ = true; } catch {}
          },
        });
      } catch { /* chrome:// 等不可注入页面 */ }
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: globalThis.WS_CONTENT_FILES,
        });
        console.log('[WennSicht] 已自愈重注入标签:', tabId);
      } catch { /* 权限撤销 / 页面已关闭：静默，下次导航自然恢复 */ }
    } catch { /* 单标签失败不影响其余 */ }
  }
}

// SW 冷启动即跑（覆盖 dev reload 与扩展更新后的首次唤醒）；不 await，避免阻塞启动。
healInvalidatedTabs().catch(() => {});
// 扩展更新时再跑一次（onInstalled 的 update 分支不触发上面的冷启动路径时兜底）。
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason === 'update') {
    wsHealDone = false;
    healInvalidatedTabs().catch(() => {});
  }
});

// 启动时执行一次历史遗留配置迁移：若旧版本把 API 密钥明文写进过 ws_ai_config，
// 这里会把它搬进加密存储并立即从配置中删除，确保磁盘上不残留明文。
// 不 await，避免阻塞 SW 启动；失败也不影响其它功能。
WS_AI.getConfig().catch(() => {});

// ---------- 开发期便捷解锁（仅开发构建生效，2026-10-01）----------
// 为什么要它：金库的"已解锁"状态存在 chrome.storage.session，而扩展**每次重载都会清空它**
// —— 开发期代码一改就重载扩展（2026-11-03 起由外部 dev/watch-reload.mjs 负责），
// 本机测试者被迫反复重输主密码（用户原话："金库动不动就锁定，你拿用户当折返跑呐"）。
// 方案：开发构建允许把本机主密码存进 storage.local，SW 每次启动自动解锁一次。
// ⚠️ 发布构建永不受影响：这里拿 manifest 的 alarms 权限当"开发构建"标记，发布版第一行就早退。
//    2026-10-04 发布清理：本目录已移除 alarms 权限，此块恒早退（发布形态）。
//    **本目录不含任何自动重载代码**：监视与重载全部在 WENNSICHT/dev/（见 dev/README.md）。
// 工具：node dev/vault-dev-unlock.mjs "主密码"（写入前会先用它试解锁，验过才存）
const VAULT_READY = (async () => {
  try {
    const isDevBuild = (chrome.runtime.getManifest().permissions || []).includes('alarms');
    if (!isDevBuild) return;
    const { ws_dev_vault_pw } = await chrome.storage.local.get('ws_dev_vault_pw');
    if (!ws_dev_vault_pw) return;
    const st = await WS_KEYVAULT.state();
    if (!st?.locked) return; // 已解锁（SW 重启但会话还在）→ 不用管
    // unlock() 成功时返回 true（不是 {ok:true}）——2026-10-02 实测：旧写法 res?.ok 永远
    // 假，日志把**每次成功的自动解锁**都报成「失败（主密码可能已改）」。这条假警报已经
    // 真的误导过排查（金库其实解锁着，却据此认定「AI 全失败的根因是金库锁定」）。
    const res = await WS_KEYVAULT.unlock(ws_dev_vault_pw);
    console.log(
      '[WennSicht] 开发期便捷解锁：' + (res ? '成功' : '失败（主密码可能已改，重跑 dev/vault-dev-unlock.mjs）')
    );
  } catch {
    /* 便捷解锁失败不影响手动解锁 */
  }
})();

// ---------- 金库就绪门（2026-10-01，owner 第 5 项反馈「图片描述生成失败」的根因之一）----------
// 机理：便捷解锁是 SW 启动期的异步任务，而内容脚本在页面加载后**可能抢在它前面**
// 发来第一次 WS_DESCRIBE_IMAGE —— 竞态下 key-vault.loadApiKeys() 因「尚未解锁」
// 静默返回空密钥 → ai.js 抛「未配置默认档 API 密钥」→ 用户听到的却是
// 「图片描述生成失败，请检查大模型配置」（指向了完全错误的排查方向）。
// 修复：所有吃密钥的消息处理器先 await 这道门再调用模型。
//   - 发布构建没有便捷解锁任务 → 立即 resolve，零行为变化；
//   - 5 秒上限保证解锁异常时调用不会永久挂起（宁可失败也不挂死）。
function vaultReady() {
  return Promise.race([VAULT_READY, new Promise((r) => setTimeout(r, 5000))]);
}

// 密钥槽位归一（2026-10-04 口径：primary 前置档 / default 默认档）。
// 旧名 main/back 兼容接受一次（热重载窗口里旧设置页可能还在发旧名）。
const normalizeKeySlot = (slot) =>
  slot === 'default' || slot === 'back' ? 'default'
    : slot === 'primary' || slot === 'main' ? 'primary'
      : null;

// ---------- NVDA 设置桥接（会话 18，非侵入式优化）----------
// NVDA 侧 add-on（仓库 nvda-bridge/）在本机回环 47653 暴露一个三键白名单端点
// （读快照 / 改白名单键），设置页经下面两条消息间接调用——用户可见的交互全部在
// 扩展设置页里，满足「操作通过插件进行」。
// 桥接插件自身不主动改任何设置：只有设置页显式请求才会写，且只认这三键：
//   autoLanguageSwitching  [speech]         语音 → 自动语言切换（若支持）
//   enableMouseTracking    [mouse]          鼠标 → 启用鼠标导航
//   autoSayAllOnPageLoad   [virtualBuffers] 浏览模式 → 页面加载完成后朗读所有内容
// ⚠️ 常量三处必须一致：本文件 / nvda-bridge/globalPlugins/wennsichtBridge/core.py /
//    dev/verify-nvda-bridge.mjs（端口 47653、前缀 /wennsicht/v1、头 X-WennSicht-Bridge）。
const NVDA_BRIDGE_BASE = 'http://127.0.0.1:47653/wennsicht/v1';
async function nvdaBridgeRequest(action, msg) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, 3000);
  try {
    const bridgePath = action === 'set' ? '/set' : action === 'cursor' ? '/cursor' : '/status';
    const res = await fetch(NVDA_BRIDGE_BASE + bridgePath, {
      method: action === 'set' ? 'POST' : 'GET',
      headers: action === 'set'
        ? { 'X-WennSicht-Bridge': '1', 'Content-Type': 'application/json' }
        : { 'X-WennSicht-Bridge': '1' },
      body: action === 'set' ? JSON.stringify({ key: msg.key, value: msg.value }) : undefined,
      signal: ac.signal,
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error || ('桥接返回 HTTP ' + res.status) };
    }
    // bridgeVersion 由 1.3.0 起随 /status 一起返回：设置页要能显示「已装组件 x.y.z」
    return { ok: true, settings: body.settings, nvdaVersion: body.nvdaVersion, bridgeVersion: body.bridgeVersion, cursor: body.cursor };
  } catch (err) {
    // 网络错误 / 超时：桥接未运行（NVDA 未启动，或未安装桥接插件）
    return { ok: false, unreachable: true, error: timedOut ? '桥接响应超时（3 秒）' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 消息路由（内容脚本 / 设置页） ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 内容脚本问「用户实际绑定的快捷键是什么」（会话 74 · owner 要求）：
  // 播报里不许再写死 Ctrl+Shift+Z —— 用户在 chrome://extensions/shortcuts 改过键就得跟着变。
  // chrome.commands.getAll() 只有扩展自身能调，所以由 SW 统一取，并顺手刷新 storage 缓存
  //（内容脚本在 SW 未就绪时可退回缓存读）。
  if (msg?.type === 'WS_GET_SHORTCUTS') {
    (async () => {
      try {
        const list = await chrome.commands.getAll();
        const shortcuts = {};
        for (const c of list) if (c?.name && c.shortcut) shortcuts[c.name] = c.shortcut;
        // 每个页面加载都会来问一次 ⇒ 只在真的变了的时候写盘，避免无意义的 storage 写入。
        try {
          const prev = (await chrome.storage.local.get('ws_shortcut_map')).ws_shortcut_map;
          if (JSON.stringify(prev || {}) !== JSON.stringify(shortcuts)) {
            await chrome.storage.local.set({ ws_shortcut_map: shortcuts, ws_shortcut_at: Date.now() });
          }
        } catch { /* 写入失败不影响回包 */ }
        sendResponse({ ok: true, shortcuts });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 内容脚本加载后同步当前开关状态 → 恢复徽标
  if (msg?.type === 'WS_STATE_SYNC') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) setBadge(tabId, msg.on ? BADGE_ON : BADGE_OFF);
    return;
  }

  // 内容脚本请求「把当前站点加入常用站点」（2026-10-24，owner 六情形 ⑤⑥）：
  // 逐站模式下用户在某站按了 Ctrl+Shift+Z —— 这是明确表态，于是把它写进 ws_sites 并记住开启，
  // 下次打开自动生效。**全局模式不写**（没必要，所有站点已经覆盖）。
  //
  // 注册内容脚本需要该 origin 的 host 权限：有权限才注册（否则动态注册会抛错）；
  // 没权限时**不弹权限框**（盲用户难以应付原生对话框），只把站点记进列表，
  // 下次仍可用快捷键「仅本页」临时开启。
  if (msg?.type === 'WS_PERSIST_SITE') {
    (async () => {
      try {
        const origin = String(msg.origin || '');
        // 只接受「当前标签页自己的源」——防止内容脚本把任意站点塞进列表
        let sameOrigin = false;
        try {
          sameOrigin = !!sender.tab?.url && new URL(sender.tab.url).origin === origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin || !/^https?:$/.test(new URL(origin).protocol)) {
          sendResponse({ added: false, reason: 'origin_mismatch' });
          return;
        }
        const { ws_global = false, ws_sites = {}, ws_active_sites = {} } =
          await chrome.storage.local.get(['ws_global', 'ws_sites', 'ws_active_sites']);
        if (ws_global === true) {
          sendResponse({ added: false, reason: 'global' });
          return;
        }
        let added = false;
        if (!ws_sites[origin]) {
          ws_sites[origin] = { addedAt: Date.now() };
          await chrome.storage.local.set({ ws_sites });
          added = true;
        }
        if (ws_active_sites[origin] !== true) {
          ws_active_sites[origin] = true;
          await chrome.storage.local.set({ ws_active_sites });
        }
        let registered = false;
        if (added) {
          try {
            const pattern = origin + '/*';
            const has = await chrome.permissions.contains({ origins: [pattern] });
            if (has) {
              await chrome.scripting.registerContentScripts([
                {
                  id: globalThis.WS_siteScriptId(origin),
                  matches: [pattern],
                  js: globalThis.WS_CONTENT_FILES,
                  runAt: 'document_idle',
                  allFrames: true,
                },
              ]);
              registered = true;
            }
          } catch (err) {
            // 已注册（duplicate）或权限不足：都不影响本次开启
            console.warn('[WennSicht] 加入常用站点时注册失败（不影响当前页面）：', err?.message || err);
          }
        }
        sendResponse({ added, registered });
      } catch (err) {
        sendResponse({ added: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 顶层文档切换开关后 → 把新状态广播给该标签页的所有子框架（2026-10-02）。
  // 有了它，"关掉增强" 才会连同 iframe 里的注入一起还原（否则 iframe 仍在被改，
  // 下次再开又会叠一遍）。子框架侧的 WS_SYNC_STATE 处理器不调用 sendResponse。
  if (msg?.type === 'WS_BROADCAST_STATE') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, { type: 'WS_SYNC_STATE', on: !!msg.on }).catch(() => {});
    }
    return;
  }

  // 公益中转状态（设置页「大模型接口」区块用，2026-10-07 会话 20）：
  // 返回端点/出厂预配/缓存的服务能力信息；refresh:true 时强制重拉 /ws/config。
  // 只返回展示信息——不含也不经手任何密钥；真实模型 ID 由中转服务端下发什么就展示什么。
  // 用户点「发送」→ 把反馈直接发到公益中转（2026-10-31）。
  // 为什么在 SW 里发：SW 是扩展 origin 且 manifest 已授权 `https://api.wennlicht.us.ci/*`
  // ⇒ 不受页面 CSP / CORS 限制；内容脚本里 fetch 会被页面 origin 规则卡住。
  // **只在用户点按钮时触发**，没有自动上报（S10 不变）。
  if (msg?.type === 'WS_FEEDBACK_SEND') {
    (async () => {
      try {
        const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
        const base = globalThis.WS_RELAY?.ENDPOINT_DEFAULT || 'https://api.wennlicht.us.ci/v1';
        const url = new URL(base).origin + '/api/feedback';
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.ok) sendResponse({ ok: true, id: data.id });
        else sendResponse({ ok: false, error: data?.error || `HTTP ${res.status}` });
      } catch (err) {
        sendResponse({ ok: false, error: err?.name === 'AbortError' ? '网络超时' : String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_RELAY_STATE') {
    (async () => {
      try {
        const endpoint = await WS_RELAY.endpoint();
        const preset = await WS_RELAY.preset();
        let relayConfig = null;
        if (msg.refresh || endpoint) {
          const r = await WS_RELAY.fetchRelayConfig({ force: !!msg.refresh });
          relayConfig = r.ok ? { fetchedAt: r.fetchedAt, data: r.data, stale: !!r.stale } : { error: r.error };
        }
        sendResponse({ ok: true, endpoint, configured: !!endpoint, preset, relayConfig });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 大模型调用（内容脚本规则模块使用，ctx.ai.chat）
  // 消息 options 只认 role 白名单（'text' | 'vision'）——其余字段（尤其任何
  // 疑似配置/密钥覆盖的内容）一律忽略，防止把真实密钥引向非预期地址。
  if (msg?.type === 'WS_AI_CHAT') {
    (async () => {
      try {
        await vaultReady();
        const role = msg.options?.role === 'vision' ? 'vision' : 'text';
        const result = await WS_AI.chat(msg.messages, { role });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 决策模型调用（内容脚本 → SW → Decisions API）：分类模型接口
  if (msg?.type === 'WS_AI_DECIDE') {
    (async () => {
      try {
        await vaultReady();
        const answers = await WS_AI.decide(msg.state || {}, msg.questions || {});
        sendResponse({ ok: true, answers });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 框架级块 gather 聚合（2026-11-03 会话 45 · 缺口 #4）v2：
  // tabs.sendMessage 多框架**只有一个响应赢家**（WS_TOGGLE 处的实测教训），无法数组聚合。
  // 改走 storage.session 交接：SW 清旧快照 → 广播 WS_QA_GATHER_REFRESH（不收响应）→
  // 各子框架把本框架的块节选写进 session storage（键 ws_qa_frame:<帧令牌>）→ SW 延迟
  // 700ms 读回合并。子框架要能写 session storage，必须放开访问级别（默认仅受信上下文）。
  if (msg?.type === 'WS_QA_GATHER_REQ') {
    (async () => {
      try {
        const old = await chrome.storage.session.get(null);
        const stale = Object.keys(old || {}).filter((k) => k.startsWith('ws_qa_frame:'));
        if (stale.length) await chrome.storage.session.remove(stale);
      } catch { /* 清理失败不影响本轮 */ }
      try {
        await chrome.tabs.sendMessage(sender.tab.id, { type: 'WS_QA_GATHER_REFRESH' });
      } catch { /* 无框架可广播 */ }
      setTimeout(async () => {
        try {
          const all = await chrome.storage.session.get(null);
          const frames = Object.entries(all || {})
            .filter(([k]) => k.startsWith('ws_qa_frame:'))
            .map(([, v]) => v)
            .filter((v) => v && Array.isArray(v.blocks) && Date.now() - (v.ts || 0) < 15000);
          try { sendResponse({ ok: true, frames }); } catch { /* 通道已关 */ }
        } catch {
          try { sendResponse({ ok: true, frames: [] }); } catch { /* 通道已关 */ }
        }
      }, 700);
    })();
    return true;
  }

  // 密钥保管（设置页请求）：明文密钥只进 SW 内存与金库密文，
  // 设置页与内容脚本永远不直接接触 key-vault。
  // 双档槽位（2026-10-04 口径）：primary 前置档（可选）/ default 默认档（必填），
  // 消息带 slot 指定（旧名 main/back 兼容一次）；WS_KEY_STATE 返回
  // { hasKey(任一档), primary, default, unlocked, needsSetup, locked }。
  // 金库化：另有 WS_KEY_SETUP / WS_KEY_UNLOCK / WS_KEY_LOCK 三条主密码消息。
  if (msg?.type === 'WS_KEY_SETUP') {
    (async () => {
      try {
        await WS_SECRETS.setupPassword(String(msg.password || ''));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_KEY_UNLOCK') {
    (async () => {
      try {
        await WS_SECRETS.unlock(String(msg.password || ''));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_KEY_LOCK') {
    (async () => {
      try {
        await WS_SECRETS.lock();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_KEY_SAVE') {
    (async () => {
      try {
        const slot = normalizeKeySlot(msg.slot) || 'primary';
        await WS_SECRETS.saveApiKey(slot, String(msg.key || ''));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_KEY_CLEAR') {
    (async () => {
      try {
        await WS_SECRETS.clearApiKey(normalizeKeySlot(msg.slot) || undefined);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.type === 'WS_KEY_STATE') {
    (async () => {
      const st = await WS_SECRETS.state();
      sendResponse({
        hasKey: st.hasKey,
        primary: st.primary,
        default: st.default,
        unlocked: st.unlocked,
        needsSetup: st.needsSetup,
        locked: st.locked,
        transitional: st.transitional,
      });
    })();
    return true;
  }

  // NVDA 设置桥接（会话 18，设置页请求）：status=读三项快照；set=白名单单键切换。
  // SW 只做转发（fetch 127.0.0.1:47653），不保存任何状态；桥接不可达时如实返回
  // unreachable:true，设置页据此显示安装引导而不是含糊报错。
  // WS_NVDA_CURSOR（2026-11-04 会话 46）：问答打开时读一次 NVDA 浏览光标所在行。
  // 这是「这节讲的是什么」唯一不依赖视口猜测的确定信号；桥接旧版本/不可达时
  // 返回 ok:false，问答静默退回原有的滚动轨迹启发式，不阻塞、不报错给用户。
  if (msg?.type === 'WS_NVDA_BRIDGE_STATUS' || msg?.type === 'WS_NVDA_BRIDGE_SET' || msg?.type === 'WS_NVDA_CURSOR') {
    (async () => {
      const action = msg.type === 'WS_NVDA_BRIDGE_SET' ? 'set'
        : msg.type === 'WS_NVDA_CURSOR' ? 'cursor' : 'status';
      sendResponse(await nvdaBridgeRequest(action, msg));
    })();
    return true;
  }

  // 图片描述（内容脚本图像管线使用）：字节在此获取以绕过页面 CORS（BP 4.4）
  // 二选一入参：url（http(s) 图片，SW 侧取图）或 dataUrl（内容脚本渲染好的画布，图表用）。
  // kind 只认白名单（'chart' / 'classify'）——不给内容脚本任意定制提示词的能力；
  // 分类提示词同样嵌在 SW 侧 vision.js 内（2026-09-29 用户需求 #8）。
  if (msg?.type === 'WS_DESCRIBE_IMAGE') {
    (async () => {
      try {
        await vaultReady();
        if (!msg.url && !msg.dataUrl) throw new Error('缺少图片地址或图片数据');
        const kind = msg.kind === 'chart' ? 'chart' : msg.kind === 'classify' ? 'classify' : msg.kind === 'long' ? 'long' : 'photo';
        const result = await WS_VISION.describeImage({
          url: msg.url,
          dataUrl: msg.dataUrl,
          context: msg.context,
          kind,
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 配置校验（设置页「保存」后调用）：验证混合 fallback 四条链路是否真的可用。
  // 刻意不接收任何来自页面的配置：只读**已保存**的配置与**已加密存储**的密钥，
  // 因此这次校验同时证明了「密文落盘 → 解密 → 调用」整条链路是通的。
  // 未配置的档位跳过（结果标 skipped）；决策模型走 default 档密钥，一并在 defaultVision 通过后提示。
  if (msg?.type === 'WS_AI_VERIFY') {
    (async () => {
      await vaultReady();
      const result = {
        primaryText: null, primaryVision: null, defaultText: null, defaultVision: null,
        route: null,
      };
      const cfg = await WS_AI.getConfig();
      const probe = async (tier, role) => {
        try {
          const r = await WS_AI.chat(
            role === 'vision'
              ? [{
                  role: 'user',
                  content: [
                    { type: 'text', text: '这张图是什么颜色？只回一个词。' },
                    { type: 'image_url', image_url: { url: await WS_VISION.makeProbeImage() } },
                  ],
                }]
              : [{ role: 'user', content: '只回复：ok' }],
            { role, tier } // 显式 tier：校验该档本身，失败不自动换档
          );
          return { ok: true, model: r.model };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      };
      const primaryCfg = cfg.primary || {};
      const defaultCfg = cfg.default || {};
      // 思考能力探测（2026-09-30 用户需求）：模型是否支持思考、关闭是否生效——
      // 结果写入 cfg[tier].reasoning[role]（disablable 才会在运行时发 enabled:false）
      const reasoningSave = {};
      const probeReasoningFor = async (tier, role) => {
        const t = tier === 'primary' ? primaryCfg : defaultCfg;
        const model = role === 'vision' ? t.visionModel : t.textModel;
        const keys = await WS_SECRETS.loadApiKeys();
        const key = keys[tier] || '';
        if (!t.baseUrl || !model) return 'unknown';
        // 公益中转档无密钥（2026-10-07）：探测照走，附设备令牌头；密钥要求仅对直连档
        if (!key && cfg.provider !== 'builtin-relay') return 'unknown';
        const extraHeaders = cfg.provider === 'builtin-relay' ? await WS_RELAY.deviceHeaders() : {};
        return await WS_AI.probeReasoningMode(t.baseUrl, model, key, extraHeaders);
      };
      if (primaryCfg.baseUrl && primaryCfg.textModel) {
        result.primaryText = await probe('primary', 'text');
        reasoningSave.text = await probeReasoningFor('primary', 'text');
      } else result.primaryText = { skipped: true };
      if (primaryCfg.baseUrl && primaryCfg.visionModel) {
        result.primaryVision = await probe('primary', 'vision');
        reasoningSave.vision = await probeReasoningFor('primary', 'vision');
      } else result.primaryVision = { skipped: true };
      if (Object.keys(reasoningSave).length) {
        await WS_AI.saveConfig({ primary: { reasoning: reasoningSave } });
        result.primaryReasoning = reasoningSave;
      }
      reasoningSave.text = undefined; reasoningSave.vision = undefined;
      if (defaultCfg.baseUrl && defaultCfg.textModel) {
        result.defaultText = await probe('default', 'text');
        reasoningSave.text = await probeReasoningFor('default', 'text');
      } else result.defaultText = { skipped: true };
      if (defaultCfg.baseUrl && defaultCfg.visionModel) {
        result.defaultVision = await probe('default', 'vision');
        reasoningSave.vision = await probeReasoningFor('default', 'vision');
      } else result.defaultVision = { skipped: true };
      if (reasoningSave.text !== undefined || reasoningSave.vision !== undefined) {
        await WS_AI.saveConfig({ default: { reasoning: reasoningSave } });
        result.defaultReasoning = reasoningSave;
      }
      result.route = WS_AI.getStats();
      sendResponse(result);
    })();
    return true;
  }
});

// 2026-10-25 SOLE_TRUTH：**任何绑定好的快捷键都要有回应**。
// 逐站模式下「没加过这个站点」时页面上根本没有内容脚本 —— 旧代码直接 catch 掉，
// 用户按 Ctrl+Shift+S / Ctrl+Shift+U 得到一片寂静，而 owner 要求「告诉他先按 Ctrl+Shift+Z」。
// 因此改为：投递失败就用快捷键这次用户手势临时注入（activeTab），再投一次；
// 注进去之后，敏感页会由内容脚本自己播「默认关闭 + 怎么强制开启」，其它页照常执行该命令。
async function sendToTabWithInject(tabId, msg, options) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, options);
  } catch {
    // 页面上没有内容脚本（或顶层框架刚导航完还没注入）
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: globalThis.WS_CONTENT_FILES,
    });
  } catch {
    // chrome:// / 扩展商店 / 银行支付等不可注入页面：静默（与旧行为一致）
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tabId, msg, options);
  } catch {
    return null;
  }
}

// 事件监听器必须在顶层同步注册（技能规则：SW 事件注册）
chrome.commands.onCommand.addListener(async (command) => {
  // 「暂停 / 继续 AI 描述」快捷键（BP 4.3）
  if (command === 'pause-image-description') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_PAUSE_IMAGES' });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  // 「页面结构摘要」快捷键（P1）：AI 总结当前页面并播报
  if (command === 'page-summary') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_SUMMARY' }, { frameId: 0 });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  // 「页面问答」快捷键（v0.2 第 9 项）：弹出只读问答对话框
  if (command === 'page-qa') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_QA_OPEN' }, { frameId: 0 });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  // 「图片长描述」快捷键（v0.2 第 10 项）：对当前所在的图发起一次长描述
  if (command === 'image-longdesc') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_LONGDESC_REQUEST' }, { frameId: 0 });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  // 「布局地图」快捷键（v0.2 第 10 项）：播报哪块该读、哪块可跳过
  if (command === 'layout-map') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_LAYOUT_REQUEST' }, { frameId: 0 });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  // 「一键反馈」快捷键（阶段 3.5）：弹出反馈对话框（报告只进剪贴板，零遥测）
  if (command === 'send-feedback') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      await sendToTabWithInject(tab.id, { type: 'WS_FEEDBACK_OPEN' }, { frameId: 0 });
    } catch {
      // 页面上没有内容脚本时无需提示
    }
    return;
  }

  if (command !== 'toggle-wennsicht') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // 1) 站点级 / 全局注册的页面：内容脚本已在，直接切换
    //    **必须显式 frameId: 0**（2026-10-02 实测真缺陷）：注册是 allFrames:true，
    //    不带 frameId 会广播到所有框架，而 sendResponse 只有一个赢家 —— 顶层文档与
    //    同源 iframe 抢同一个响应，实测 iframe 常常先抢到，于是顶层开关纹丝不动、
    //    连「已关闭」播报都没有，用户看到「按了没反应」。页面级开关只归顶层文档。
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'WS_TOGGLE' }, { frameId: 0 });
      await setBadge(tab.id, res?.on ? BADGE_ON : BADGE_OFF);
      return;
    } catch {
      // 页面上没有内容脚本（或顶层框架刚导航完还没注入）—— 转入「仅本页」临时模式
    }

    // 2) 「仅本页」临时启用（BP 4.1 三档策略的第一档）：
    //    快捷键本身即用户手势，会临时授予 activeTab，因此无需任何常驻网站权限
    //    即可注入。不写站点授权、不记忆开关，刷新页面即失效。
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: globalThis.WS_CONTENT_FILES,
      });
    } catch {
      // 无 activeTab 的场景：chrome:// 页面、扩展商店、被排除的页面等
      await setBadge(tab.id, BADGE_UNAVAILABLE);
      return;
    }

    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'WS_TOGGLE',
        ephemeral: true,
      }, { frameId: 0 });
      await setBadge(tab.id, res?.on ? BADGE_ON : BADGE_OFF);
    } catch {
      await setBadge(tab.id, BADGE_UNAVAILABLE);
    }
  } catch (err) {
    console.warn('[WennSicht] 切换失败:', err);
  }
});

// 点击扩展图标 → 打开设置页（未设置 default_popup 时才会触发）
chrome.action.onClicked.addListener(async () => {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (err) {
    console.warn('[WennSicht] 打开设置页失败:', err);
  }
});

// 会话 56：首次安装时打开一次**独立的**使用引导页（one-time wizard）。
// 只在 reason === 'install' 触发；用户完成引导后写 ws_welcome_done，之后永不自动出现。
// 政策边界（CWS Deceptive Installation FAQ）：只打开自家页面，不要求安装任何其它软件，
// 不阻断任何功能，不把可选组件设成必经步骤。update / 开发重载都不触发。
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== 'install') return;
  (async () => {
    try {
      const { ws_welcome_done: done } = await chrome.storage.local.get('ws_welcome_done');
      if (done === true) return; // 重访/重装保护：已完成就不再自动弹
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
    } catch (err) {
      console.warn('[WennSicht] 打开首次引导失败:', err);
    }
  })();
});

// 导航开始时清除该标签页的徽标（changeInfo.status 无需 tabs 权限）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    setBadge(tabId, '').catch(() => {});
  }
});

async function setBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ text, tabId });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({
        color: text === BADGE_UNAVAILABLE ? '#b00020' : '#1a4fa0',
      });
    }
  } catch {
    // 标签页可能已关闭，忽略
  }
}
