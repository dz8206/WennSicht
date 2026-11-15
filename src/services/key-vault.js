// API 密钥金库（WebCrypto AES-GCM 本地加密存储，2026-09-30 起 replaces DPAPI 宿主）
//
// 方案来源：《API加密本地储存.docx》（WebCrypto AES-GCM + PBKDF2 研究报告）。
// 与旧 DPAPI Native Messaging 宿主方案相比：
//   - 零外部进程、零 .ps1、零注册表 —— 纯扩展内实现，Windows/macOS/Linux 通用；
//   - crx 打包给测试用户无需再注册宿主；manifest 不再需要 nativeMessaging 权限；
//   - 密文（JSON 信封）存 chrome.storage.local（扩展 ID 隔离，其他扩展/网页读不到）；
//   - 解锁态（DEK 原始字节 + 主密码）只进 chrome.storage.session（内存态，浏览器
//     一关就清，绝不落盘）；SW 内存里的明文密钥随 SW 终止消失。
//
// 密钥层次（报告 §6.1）：
//   主密码（用户输入，不存储——除迁移过渡期，见下）
//     └─ KEK = PBKDF2-SHA256(主密码, 盐16B, 600000 轮)   [不可提取]
//          └─ wrappedDek = AES-GCM(KEK, DEK 原始字节)     （换主密码只重包 DEK）
//               └─ DEK（AES-GCM-256，随机生成）           [导入为不可提取]
//                    └─ primary / default 两条 API 密钥的密文（每条独立 IV + 槽位 AAD）
//
// 信封格式（报告 §9，存 chrome.storage.local 的 'ws_key_vault'）：
//   { v:1, kdf:{alg,iterations,salt}, cipher:{alg,tagLength},
//     wrappedDek:{iv,ciphertext}, apiKeys:{ primary:{iv,ciphertext,createdAt}, default:{...} } }
//   ciphertext 均为 WebCrypto 原生输出（认证标签拼接在密文尾）。
//   每条密钥的 AAD 绑定槽位名（'ws-vault-v1|primary'），防密文跨槽调包。
//
// 槽位改名迁移（2026-10-04 口径变更：main→primary、back→default）：
//   旧密文的 AAD 绑着旧槽名，改名必须解密后重封（需要解锁态）。读路径保留
//   别名兼容（旧槽名照常解密）；解锁后由 migrateLegacySlots() 一次性重封
//   为新槽名并删除旧密文，失败的单条保留旧密文、绝不丢密钥。
//
// 解锁模型：
//   - 「已解锁」= SW 内存持有 DEK（CryptoKey）或 chrome.storage.session 里有
//     dekRaw/mpw。SW 被杀 → 下次唤醒从 session 一键恢复（一次 importKey，毫秒级）；
//     浏览器关闭 → session 清空 → 回到锁定态，需要用户重输主密码。
//   - lock()：清 session + 清内存。设置页可手动锁；浏览器重开自动回到锁定。
//   - loadApiKeys() 在锁定态返回空槽（AI 功能自然静默关闭，不报错不重试）；
//     设置页经 WS_KEY_STATE.locked 得知锁定并提示解锁。
//
// 迁移（一次性，透明）：老用户密钥在 %LOCALAPPDATA%\WennSicht\dev-api-key.bin（DPAPI）。
//   首次唤醒若无金库则尝试经旧宿主读出双槽密钥 → 自动建金库存入。
//   过渡期用「随机主密码」，暂存 storage.local 的 ws_key_migration_pw ——
//   ★ 如实说明：设置主密码前，迁移过渡期的密文保护弱于 DPAPI（本地攻击者可从
//   storage 里同时拿到信封与过渡密码）；用户在设置页设置自己的主密码后该明文
//   即被删除。此前没有旧密钥的用户（或宿主未注册的机器）不产生过渡密码，直接
//   引导设置主密码。
//
// 能力边界（与 DPAPI 方案对比如实陈述，不夸大）：
//   - 挡得住：翻磁盘 LevelDB（无主密码只有密文）、其他扩展/网页（存储按扩展隔离）、
//     密钥出现在命令行/日志/DOM（与旧方案同）、跨系统复制（纯 WebCrypto 无平台依赖）。
//   - 挡不住：同一系统用户运行恶意程序读浏览器进程内存（解锁态任何用户态方案皆然）、
//     弱主密码的离线暴力破解（600k 轮 PBKDF2 抬高成本但非无限）。
//
// 绝对禁止：把主密码/明文密钥写进 console、日志、DOM、storage.local。
// 本文件在 SW 与 Node 测试环境均可运行：加密核心不触碰 chrome.*（globalThis.WS_KEYVAULT_CORE），
// SW 封装层才用 chrome.storage（globalThis.WS_KEYVAULT）。

globalThis.WS_KEYVAULT_CORE = (() => {
  'use strict';

  const KDF_ITERATIONS = 600000;
  const AAD_DEK = 'ws-vault-v1|dek';

  // ---- base64（SW 与 Node 都有 btoa/atob）----
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function unb64(text) {
    const bin = atob(String(text || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const te = () => new TextEncoder();
  const td = () => new TextDecoder();

  function subtle() {
    if (!globalThis.crypto?.subtle) throw new Error('此环境没有 WebCrypto (crypto.subtle)');
    return globalThis.crypto.subtle;
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  async function deriveKek(password, saltBytes, iterations) {
    const material = await subtle().importKey(
      'raw', te().encode(String(password)), 'PBKDF2', false, ['deriveKey']
    );
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations || KDF_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false, // KEK 不可提取
      ['encrypt', 'decrypt']
    );
  }

  // 新建金库信封：返回 { vault, dekRaw, dek }（dek 为不可提取 CryptoKey）
  async function createVaultEnvelope(password) {
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, KDF_ITERATIONS);
    const rawDek = randomBytes(32);
    const wrapIv = randomBytes(12);
    const wrapped = await subtle().encrypt(
      { name: 'AES-GCM', iv: wrapIv, tagLength: 128, additionalData: te().encode(AAD_DEK) },
      kek,
      rawDek
    );
    const dek = await subtle().importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const vault = {
      v: 1,
      kdf: { alg: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: b64(salt) },
      cipher: { alg: 'AES-GCM-256', tagLength: 128 },
      wrappedDek: { iv: b64(wrapIv), ciphertext: b64(new Uint8Array(wrapped)) },
      apiKeys: {},
    };
    return { vault, dekRaw: rawDek, dek };
  }

  // 主密码 + 信封 → DEK（CryptoKey 与原始字节）。密码错误/信封被篡改 → throw。
  async function unwrapDek(password, vault) {
    if (!vault?.kdf?.salt || !vault?.wrappedDek?.iv || !vault?.wrappedDek?.ciphertext) {
      throw new Error('金库信封不完整');
    }
    const kek = await deriveKek(password, unb64(vault.kdf.salt), vault.kdf.iterations);
    const rawDek = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(vault.wrappedDek.iv), tagLength: 128, additionalData: te().encode(AAD_DEK) },
      kek,
      unb64(vault.wrappedDek.ciphertext)
    );
    const dek = await subtle().importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return { dek, dekRaw: new Uint8Array(rawDek) };
  }

  // 换主密码：用旧解锁态里的 DEK 原始字节重新包一层新 KEK（apiKeys 密文不动）
  async function rewrapVault(vault, dekRaw, newPassword) {
    const salt = randomBytes(16);
    const kek = await deriveKek(newPassword, salt, KDF_ITERATIONS);
    const wrapIv = randomBytes(12);
    const wrapped = await subtle().encrypt(
      { name: 'AES-GCM', iv: wrapIv, tagLength: 128, additionalData: te().encode(AAD_DEK) },
      kek,
      dekRaw
    );
    return {
      ...vault,
      kdf: { alg: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, salt: b64(salt) },
      cipher: { alg: 'AES-GCM-256', tagLength: 128 },
      wrappedDek: { iv: b64(wrapIv), ciphertext: b64(new Uint8Array(wrapped)) },
    };
  }

  // 用 DEK 加密一条 API 密钥（slot 进 AAD）
  async function sealApiKey(dek, slot, plain) {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv, tagLength: 128, additionalData: te().encode('ws-vault-v1|' + slot) },
      dek,
      te().encode(String(plain))
    );
    return { iv: b64(iv), ciphertext: b64(new Uint8Array(ct)), createdAt: Date.now() };
  }

  // 解密一条；任何失败（被篡改/换槽）→ throw
  async function openApiKey(dek, slot, entry) {
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(entry.iv), tagLength: 128, additionalData: te().encode('ws-vault-v1|' + slot) },
      dek,
      unb64(entry.ciphertext)
    );
    return td().decode(pt);
  }

  return {
    KDF_ITERATIONS,
    createVaultEnvelope, unwrapDek, rewrapVault, sealApiKey, openApiKey,
    b64, unb64,
  };
})();

// ===================== SW 封装层（仅 Service Worker 加载） =====================
// 依赖 chrome.storage；内容脚本与设置页不得加载本文件（密钥只进 SW 内存）。
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  globalThis.WS_KEYVAULT = (() => {
    'use strict';

    const CORE = globalThis.WS_KEYVAULT_CORE;
    const VAULT_KEY = 'ws_key_vault';          // 信封（storage.local，密文）
    const MIG_PW_KEY = 'ws_key_migration_pw';  // 迁移过渡密码（storage.local，见文件头说明）
    const SLOTS = ['primary', 'default'];      // 新口径槽位（2026-10-04 起）
    const LEGACY_SLOT = { main: 'primary', back: 'default' }; // 旧槽名 → 新槽名
    const SLOT_PREV = { primary: 'main', default: 'back' };   // 新槽名 → 旧槽名
    const normalizeSlot = (slot) => (SLOTS.includes(slot) ? slot : LEGACY_SLOT[slot] || null);

    let dek = null;        // 解锁后的 DEK（不可提取 CryptoKey，SW 生命周期内有效）
    let dekRaw = null;     // 对应原始字节（setup 换密码用；lock 时 fill(0)）

    const SESSION_STORE = chrome.storage.session || chrome.storage.local; // session 不可用时退化（不理想但能用）
    const SESSION_DEK = chrome.storage.session ? 'ws_vault_dek' : 'ws_vault_dek_local';
    const SESSION_MPW = chrome.storage.session ? 'ws_vault_mpw' : 'ws_vault_mpw_local';

    async function readVault() {
      const got = await chrome.storage.local.get(VAULT_KEY);
      return got?.[VAULT_KEY] || null;
    }
    async function writeVault(vault) {
      await chrome.storage.local.set({ [VAULT_KEY]: vault });
    }

    function clearMemKeys() {
      dek = null;
      if (dekRaw) { dekRaw.fill(0); dekRaw = null; }
    }

    // ---- 解锁链：内存 → session.dekRaw → session.mpw → 迁移过渡密码 → 锁定 ----
    async function ensureUnlocked() {
      if (dek) return true;

      const ses = await SESSION_STORE.get([SESSION_DEK, SESSION_MPW]);
      const dekB64 = ses?.[SESSION_DEK];
      const mpw = ses?.[SESSION_MPW];

      if (dekB64) {
        try {
          dekRaw = CORE.unb64(dekB64);
          dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
          return true;
        } catch { clearMemKeys(); }
      }
      if (mpw) {
        try {
          const vault = await readVault();
          const unwrapped = await CORE.unwrapDek(mpw, vault);
          dek = unwrapped.dek;
          dekRaw = unwrapped.dekRaw;
          await SESSION_STORE.set({ [SESSION_DEK]: CORE.b64(dekRaw) });
          return true;
        } catch { /* session 里的密码与金库不匹配（重装等）：当作锁定 */ }
      }

      // 迁移过渡密码（一次性升级路径，见文件头）
      const mig = await chrome.storage.local.get(MIG_PW_KEY);
      if (mig?.[MIG_PW_KEY]) {
        try {
          const vault = await readVault();
          const unwrapped = await CORE.unwrapDek(mig[MIG_PW_KEY], vault);
          dek = unwrapped.dek;
          dekRaw = unwrapped.dekRaw;
          await SESSION_STORE.set({
            [SESSION_DEK]: CORE.b64(dekRaw),
            [SESSION_MPW]: mig[MIG_PW_KEY],
          });
          return true;
        } catch { /* 过渡密码与信封不匹配：继续当锁定处理 */ }
      }
      return false;
    }

    // ---- 一次性迁移：旧 DPAPI 宿主 → 金库（失败可重试，成功即永久标记）----
    let migrationDone = null; // null=未检查 true/false
    async function migrateFromHost() {
      if (migrationDone !== null) return migrationDone;
      // 金库已存在（用户已设主密码/已迁移过）→ 绝不重跑，防止过渡金库覆盖用户金库
      if (await readVault()) { migrationDone = true; return true; }
      if (typeof chrome.runtime.sendNativeMessage !== 'function') { migrationDone = true; return true; }
      let blob = null;
      try {
        blob = await new Promise((resolve) => {
          let settled = false;
          const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 8000);
          try {
            chrome.runtime.sendNativeMessage('com.wennsicht.keychain', { op: 'get' }, (res) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (chrome.runtime.lastError?.message) return resolve(null);
              resolve(res?.ok ? String(res.value || '') : null);
            });
          } catch { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } }
        });
      } catch { blob = null; }
      if (!blob) { migrationDone = true; return true; } // 宿主不在/无密钥：无需迁移

      // 旧 blob：JSON {main,back} 双槽（旧命名），或旧单串视作 default（单档基线）
      let keys = { primary: '', default: '' };
      try {
        const obj = JSON.parse(blob);
        if (obj && typeof obj === 'object') {
          keys = {
            primary: String(obj.main || obj.primary || ''),
            default: String(obj.back || obj.default || ''),
          };
        }
      } catch { keys = { primary: '', default: blob }; }
      if (!keys.primary && !keys.default) { migrationDone = true; return true; }

      // 随机过渡密码建库（弱保护过渡期，用户设置主密码后即消除，见文件头）
      const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const pwLen = 48;
      const rnd = new Uint8Array(pwLen);
      crypto.getRandomValues(rnd);
      let migPw = '';
      for (let i = 0; i < pwLen; i++) migPw += chars[rnd[i] % chars.length];
      const env = await CORE.createVaultEnvelope(migPw);
      env.vault.transitional = true; // 迁移过渡金库：设置页会提醒用户设置自己的主密码
      for (const slot of SLOTS) {
        if (keys[slot]) env.vault.apiKeys[slot] = await CORE.sealApiKey(env.dek, slot, keys[slot]);
      }
      await writeVault(env.vault);
      await chrome.storage.local.set({ [MIG_PW_KEY]: migPw });
      dek = env.dek;
      dekRaw = env.dekRaw;
      await SESSION_STORE.set({ [SESSION_DEK]: CORE.b64(dekRaw), [SESSION_MPW]: migPw });
      migrationDone = true;
      return true;
    }

    // ---------- 对外 API（WS_SECRETS；2026-10-04 起槽位口径 primary / default） ----------

    // 槽位改名迁移（一次性，见文件头）：旧 main/back 密文重封为 primary/default。
    // 只在解锁态执行；失败保留旧密文，读取别名仍可用，下一次解锁再试。
    let legacySlotsMigrated = false;
    async function migrateLegacySlots() {
      if (legacySlotsMigrated) return;
      if (!(await ensureUnlocked())) return;
      legacySlotsMigrated = true; // 先标记：串行区内即便失败也不反复重试（下次 SW 启动再试）
      await serialized(async () => {
        const vault = await readVault();
        if (!vault?.apiKeys) return;
        let changed = false;
        for (const [oldSlot, newSlot] of Object.entries(LEGACY_SLOT)) {
          const entry = vault.apiKeys[oldSlot];
          if (!entry) continue;
          if (!vault.apiKeys[newSlot]) {
            try {
              const plain = await CORE.openApiKey(dek, oldSlot, entry);
              vault.apiKeys[newSlot] = await CORE.sealApiKey(dek, newSlot, plain);
            } catch {
              continue; // 解不开的单条：保留旧密文（读路径按旧槽名解密），不阻塞其它
            }
          }
          delete vault.apiKeys[oldSlot];
          changed = true;
        }
        if (changed) await writeVault(vault);
      }).catch(() => {});
    }

    // 写操作串行队列：save/clear/setup 并发时各自「读-改-写」整个信封，
    // 后写者会用旧快照覆盖先写者的槽位（2026-09-30 实测：并发双槽保存 → main 被吞）。
    // 金库是单写者资源，串行化是正解（每次操作都重新读最新信封）。
    let writeChain = Promise.resolve();
    function serialized(fn) {
      const run = writeChain.then(fn, fn); // 前序失败也不阻塞后续
      writeChain = run.then(() => {}, () => {});
      return run;
    }

    // 读取双档密钥明文（新口径键名 primary / default）。锁定态返回空槽
    //（AI 功能自然关闭），不抛错；旧 main/back 密文按原槽名解密读出。
    async function loadApiKeys() {
      await migrateFromHost().catch(() => {});
      if (!(await ensureUnlocked())) return { primary: '', default: '' };
      await migrateLegacySlots();
      const vault = await readVault();
      if (!vault?.apiKeys) return { primary: '', default: '' };
      const out = { primary: '', default: '' };
      for (const slot of SLOTS) {
        // 优先新槽名；旧槽名（AAD 绑定旧名）作为兼容回退
        for (const name of [slot, SLOT_PREV[slot]]) {
          const entry = vault.apiKeys[name];
          if (!entry) continue;
          try { out[slot] = await CORE.openApiKey(dek, name, entry); }
          catch { out[slot] = ''; } // 单条损坏不影响另一条
          break;
        }
      }
      return out;
    }

    // 保存单槽（slot: 'primary'|'default'；旧名 main/back 也接受，自动归一）。
    // 金库锁定且无法自动解锁时抛错（设置页提示解锁）。
    function saveApiKey(slot, plain) {
      return serialized(() => saveApiKeyInner(slot, plain));
    }
    async function saveApiKeyInner(slot, plain) {
      const target = normalizeSlot(slot);
      if (!target) throw new Error(`未知密钥槽位：${slot}`);
      const text = String(plain || '');
      if (!text) throw new Error('密钥为空');
      await migrateFromHost().catch(() => {});
      if (!(await ensureUnlocked())) {
        const existing = await readVault();
        throw new Error(
          existing
            ? '密钥金库已锁定：请先在设置页「密钥金库主密码」解锁，再保存密钥'
            : '尚未设置主密码：请先在设置页「密钥金库主密码」设置主密码，再保存密钥'
        );
      }
      const vault = await readVault();
      vault.apiKeys[target] = await CORE.sealApiKey(dek, target, text);
      delete vault.apiKeys[SLOT_PREV[target]]; // 同一槽的旧密文一并清掉，避免读路径歧义
      await writeVault(vault);
    }

    // 清除：带 slot 清单槽（旧名自动归一）；不带清全部（保留金库与解锁态）
    function clearApiKey(slot) {
      return serialized(() => clearApiKeyInner(slot));
    }
    async function clearApiKeyInner(slot) {
      const vault = await readVault();
      if (!vault) return;
      const target = normalizeSlot(slot);
      if (target) {
        delete vault.apiKeys[target];
        delete vault.apiKeys[SLOT_PREV[target]];
        await writeVault(vault);
        return;
      }
      vault.apiKeys = {};
      await writeVault(vault);
    }

    async function hasApiKeys() {
      await migrateFromHost().catch(() => {});
      const vault = await readVault();
      const apiKeys = vault?.apiKeys || {};
      return {
        primary: !!(apiKeys.primary || apiKeys.main),
        default: !!(apiKeys.default || apiKeys.back),
      };
    }

    // ---- 主密码生命周期 ----

    // 设置（或更换）主密码。无金库 → 新建；有金库 → 需当前可解锁（重输旧密码或迁移态）。
    function setupPassword(newPassword) {
      return serialized(() => setupPasswordInner(newPassword));
    }
    async function setupPasswordInner(newPassword) {
      const pw = String(newPassword || '');
      if (pw.length < 8) throw new Error('主密码至少 8 位');

      const vault = await readVault();
      if (!vault) {
        const env = await CORE.createVaultEnvelope(pw);
        await writeVault(env.vault);
        dek = env.dek;
        dekRaw = env.dekRaw;
      } else {
        if (!(await ensureUnlocked())) {
          throw new Error('金库已锁定：请先用当前主密码解锁，再更换主密码');
        }
        const rewrapped = await CORE.rewrapVault(vault, dekRaw, pw);
        delete rewrapped.transitional; // 用户自设主密码后不再是过渡金库
        await writeVault(rewrapped);
      }
      await SESSION_STORE.set({ [SESSION_MPW]: pw, [SESSION_DEK]: CORE.b64(dekRaw) });
      await chrome.storage.local.remove(MIG_PW_KEY); // 迁移过渡密码就此退役
      return true;
    }

    // 用主密码解锁（金库不存在 → 提示先设置）
    async function unlock(password) {
      const vault = await readVault();
      if (!vault) throw new Error('尚未设置主密码');
      const pw = String(password || '');
      const unwrapped = await CORE.unwrapDek(pw, vault); // 密码错 → throw（GCM 认证失败）
      dek = unwrapped.dek;
      dekRaw = unwrapped.dekRaw;
      await SESSION_STORE.set({
        [SESSION_MPW]: pw,
        [SESSION_DEK]: CORE.b64(dekRaw),
      });
      return true;
    }

    // 手动锁定：清 session 与内存。浏览器关闭时 session 本来就会被清。
    async function lock() {
      clearMemKeys();
      await SESSION_STORE.remove([SESSION_MPW, SESSION_DEK]);
      return true;
    }

    async function state() {
      await migrateFromHost().catch(() => {});
      const vault = await readVault();
      const has = await hasApiKeys();
      const unlocked = await ensureUnlocked();
      await migrateLegacySlots();
      const needsSetup = !vault;
      return {
        hasKey: has.primary || has.default,
        primary: has.primary,
        default: has.default,
        unlocked,          // 解锁态（主密码可用）
        needsSetup,        // 尚未设置主密码（迁移过渡或全新安装）
        locked: !!vault && !unlocked, // 有金库但锁着
        transitional: !!vault?.transitional, // 迁移过渡金库（提醒设置主密码）
      };
    }

    // SW 顶层同步注册：浏览器关闭 = session 自动清空（锁定），无需额外事件。
    // 手动锁定入口由设置页经 WS_KEY_LOCK 触发（service-worker.js 接线）。

    return { saveApiKey, loadApiKeys, clearApiKey, hasApiKeys, setupPassword, unlock, lock, state };
  })();
}
