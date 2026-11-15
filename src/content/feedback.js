// 阶段 3.5：一键反馈（BP 4.6 / TODOLIST 3.5）
//
// 快捷键（Ctrl+Shift+U）→ SW 路由 WS_FEEDBACK_OPEN → 本模块弹出无障碍对话框：
//   - 用户写问题描述 + 选择屏幕阅读器类型
//   - 明示将附带哪些信息（网址 / 版本），逐项勾选同意后才附带（BP：用户同意后才附带）
//   - 两种出口，都由用户点：
//       ① **「发送给开发者」**（2026-10-31 起）：把这份报告 POST 到公益中转 `/api/feedback`，
//          存进 owner 的 D1（可选推送到手机）。**只在点击这一刻发生**，没有自动上报、
//          没有后台采样——S10「零遥测」不变：遥测 = 无用户动作的数据外发，本路径不是。
//       ② 「只复制报告」：不联网，仅复制到剪贴板（网络不通时的退路也走这条）
//   - 报告全文同时显示在只读文本框里，屏幕阅读器可直接朗读核对
//
// 无障碍细节：role=dialog + aria-modal、初始焦点落在描述框、ESC 关闭、
// 关闭后焦点归还原元素。对话框标记 data-ws-ignore-obs（增量扫描跳过）。
window.WS_FEEDBACK_UI = (() => {
  let dialog = null;
  let lastFocus = null;
  let focusTrap = null;


  // 上传的**全部内容**（就是下面这份报告，逐字一致）——不多带任何东西
  function buildPayload(opts) {
    // 2026-10-31：不再询问屏幕阅读器——目前只适配 NVDA，问了也是白问一个选项。
    return {
      v: 1,
      ver: opts.includeVersion ? chrome.runtime.getManifest().version : '',
      // 只带 origin + path：query 里常有会话参数，不带（最小必要信息）
      url: opts.includeUrl ? `${location.origin}${location.pathname}` : '',
      note: clean(opts.description || ''),
      lang: (document.documentElement.getAttribute('lang') || '').slice(0, 20),
    };
  }

  const clean = (v) => String(v == null ? '' : v).trim().slice(0, 2000);

  // 人读版（对话框里显示 + 复制到剪贴板）。**与实际发送的字段一一对应**，
  // 用户核对这份就等于核对将要发出去的东西。
  function buildReport(payload, mode = 'copy') {
    const lines = ['循光WennSicht 反馈报告', '────────────────'];
    lines.push(`时间：${new Date().toLocaleString('zh-CN')}`);
    if (payload.url) lines.push(`网址：${payload.url}`);
    if (payload.ver) lines.push(`扩展版本：${payload.ver}`);
    lines.push(`问题描述：${payload.note || '（未填写）'}`);
    lines.push('────────────────',
      mode === 'send'
        ? '发送方式：你在反馈对话框里点了「发送」，只发这一份，扩展不会在别处上报任何数据。'
        : '发送方式：仅复制到剪贴板（未上传）。');
    return lines.join('\n');
  }

  async function copyText(text) {
    // 剪贴板 API 在个别环境会悬而不决（权限提示被吞、无焦点），
    // 2.5 秒没结果就视为失败，落到 execCommand 兜底，绝不让对话框卡住
    try {
      const withTimeout = Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 2500)),
      ]);
      await withTimeout;
      return true;
    } catch {
      // 剪贴板 API 不可用时的兜底：选中文本 + execCommand
      try {
        const ta = dialog?.querySelector('#ws-fb-report');
        if (!ta) return false;
        ta.focus();
        ta.select();
        return document.execCommand('copy');
      } catch {
        return false;
      }
    }
  }

  function close() {
    if (!dialog) return;
    // 顺序（2026-10-11 取证，与长描述选图对话框同一结论）：**先把焦点还给打开前的元素，
    // 再移除对话框**。反序时被聚焦的控件随节点销毁 → Chrome 把焦点退回文档对象并为此
    // 派发 a11y 焦点事件 → 读屏重读文档标题 + 当前行，随后才轮到归还的焦点——用户听到的
    // 就是「关掉对话框后反被念了一段页面内容」。先解绑自己的焦点陷阱：归还目标在对话框外。
    if (focusTrap) {
      document.removeEventListener('focusin', focusTrap, true);
      focusTrap = null;
    }
    if (lastFocus && lastFocus.isConnected) lastFocus.focus?.();
    lastFocus = null;
    // 归还目标接不住焦点（最常见：打开对话框时页面 DOM 焦点就是 body，而 body.focus()
    // 在 Chrome 里不是一次真实焦点移动）→ 交接到扩展隐藏停放点，否则 remove() 仍然会
    // 销毁焦点 → 读屏重读文档（2026-10-11 verify-feedback 实测：反序 + 归还目标不可聚焦
    // 时，remove() 记录里仍是 focusedInside=true）。用**独立全局**而不是 ctx：反馈在
    // 未开启增强时也可用，那时 open(ctx) 收到的是 null。
    // **落点必须带文案**（2026-10-11 会话 29）：无名落点会让读屏「聚焦无名 generic → 重定位
    // 念页面内容」，带文案落点则恰好只念这一句。文案 = 本对话框关闭的那一句话。
    if (window.WS_FOCUS_PARK?.park && dialog.contains(document.activeElement)) {
      window.WS_FOCUS_PARK.park('问题反馈窗口已关闭。');
    }
    dialog.remove();
    dialog = null;
  }

  function open(ctx) {
    // v0.2：反馈对话框只在顶层文档弹 —— 快捷键消息广播到所有框架时，
    // 否则一个页面会同时弹出 N 个对话框。
    if (window.top !== window) return;
    if (dialog) {
      dialog.querySelector('#ws-fb-desc')?.focus();
      return;
    }
    if (!document.body) return;
    lastFocus = document.activeElement;

    const root = document.createElement('div');
    root.setAttribute('data-ws-ignore-obs', '');
    // 自管焦点契约（content.js 的 site-modal 看护据此绕开）：本对话框自己把焦点送入 +
    // 自己拉回 + 关闭时先归还后移除（2026-10-11 选图对话框实证：看护的陷阱会在归还瞬间
    // 把焦点拉回对话框内，看护的「弹窗关闭那轮」还会把焦点还原到打开前的页面元素 →
    // 两次都把读屏重新指向文档）。
    root.setAttribute('data-ws-modal-self', '');
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.4);font-family:system-ui,sans-serif;';

    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'ws-fb-title');
    box.style.cssText =
      'background:#fff;color:#111;max-width:30em;width:92%;padding:18px 20px;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.35);line-height:1.6;';
    root.appendChild(box);

    const esc = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    root.addEventListener('keydown', esc);

    // 标题
    const h = document.createElement('h2');
    h.id = 'ws-fb-title';
    h.textContent = '问题反馈';
    h.style.cssText = 'margin:0 0 6px;font-size:1.15em;';
    box.appendChild(h);

    const hint = document.createElement('p');
    hint.textContent = '点「发送给开发者」会把下面这份报告直接发给我们（走公益中转，只存报告本身，不含页面内容）；'
      + '不想联网就点「只复制报告」。扩展不会在别的时候上报任何数据。';
    hint.style.cssText = 'margin:0 0 10px;color:#555;font-size:.9em;';
    box.appendChild(hint);

    // 问题描述
    const descLabel = document.createElement('label');
    descLabel.htmlFor = 'ws-fb-desc';
    descLabel.textContent = '遇到了什么问题？';
    descLabel.style.cssText = 'display:block;font-weight:bold;margin-bottom:4px;';
    box.appendChild(descLabel);
    const desc = document.createElement('textarea');
    desc.id = 'ws-fb-desc';
    desc.rows = 3;
    desc.style.cssText = 'width:100%;box-sizing:border-box;font:inherit;margin-bottom:10px;';
    box.appendChild(desc);

    // 附带信息勾选（BP：用户同意后才附带）
    const mkCheck = (id, label, checked) => {
      const lab = document.createElement('label');
      lab.style.cssText = 'display:block;margin-bottom:4px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.checked = checked;
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + label));
      box.appendChild(lab);
      return cb;
    };
    const cbUrl = mkCheck('ws-fb-url', '附带当前网址（不含查询参数）', true);
    const cbVer = mkCheck('ws-fb-ver', '附带扩展版本号', true);

    // 按钮
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'margin-top:12px;display:flex;gap:10px;';
    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.id = 'ws-fb-send';
    sendBtn.textContent = '发送给开发者';
    sendBtn.style.cssText = 'font:inherit;padding:6px 16px;cursor:pointer;font-weight:bold;';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.id = 'ws-fb-copy';
    copyBtn.textContent = '只复制报告';
    copyBtn.style.cssText = 'font:inherit;padding:6px 16px;cursor:pointer;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = 'ws-fb-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'font:inherit;padding:6px 16px;cursor:pointer;';
    btnRow.append(sendBtn, copyBtn, cancelBtn);
    box.appendChild(btnRow);

    // 报告预览（生成后填充；屏幕阅读器可直接朗读核对）
    const report = document.createElement('textarea');
    report.id = 'ws-fb-report';
    report.readOnly = true;
    report.rows = 6;
    report.setAttribute('aria-label', '报告内容（发送或复制的就是这一份）');
    report.style.cssText = 'width:100%;box-sizing:border-box;font-size:.85em;margin-top:10px;display:none;';
    box.appendChild(report);

    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:6px 0 0;font-weight:bold;min-height:1.4em;';
    box.appendChild(status);

    const readOpts = () => ({
      description: desc.value,
      includeUrl: cbUrl.checked,
      includeVersion: cbVer.checked,
    });
    const setBusy = (busy, text) => {
      for (const b of [sendBtn, copyBtn, cancelBtn]) b.disabled = busy;
      if (text) status.textContent = text;
    };

    sendBtn.addEventListener('click', async () => {
      const payload = buildPayload(readOpts());
      if (!payload.note) {
        status.textContent = '先写一句「遇到了什么问题」再发送（我们看不到你的页面内容，只能靠这句话定位）。';
        desc.focus();
        ctx?.announce(status.textContent);
        return;
      }
      const text = buildReport(payload, 'send');
      report.value = text;
      report.style.display = 'block';
      setBusy(true, '正在发送…');
      let res = null;
      try {
        res = await chrome.runtime.sendMessage({ type: 'WS_FEEDBACK_SEND', payload });
      } catch (err) {
        res = { ok: false, error: String(err?.message || err) };
      }
      setBusy(false);
      if (res?.ok) {
        // 成功也留一份在剪贴板：用户想再补充说明时能直接粘
        copyText(text);
        status.textContent = `已发送给开发者（编号 ${res.id || '—'}）。也复制了一份到剪贴板留底。`;
      } else {
        const ok = await copyText(text);
        const why = res?.error || '网络不通';
        status.textContent = `发送失败：${why}。` +
          (ok ? '报告已复制到剪贴板，可手动发给我们。' : '请在下方文本框手动全选复制。');
      }
      ctx?.announce(status.textContent);
    });

    copyBtn.addEventListener('click', async () => {
      const text = buildReport(buildPayload(readOpts()), 'copy');
      report.value = text;
      report.style.display = 'block';
      const ok = await copyText(text);
      status.textContent = ok
        ? '报告已复制到剪贴板，可直接粘贴给开发者。'
        : '自动复制失败，请在下方文本框手动全选复制。';
      ctx?.announce(status.textContent);
    });
    cancelBtn.addEventListener('click', () => close());

    dialog = root;
    document.body.appendChild(root);
    // Tab 看护改由本对话框自己承担（看护已绕开 data-ws-modal-self）：声明了 aria-modal
    // 却允许焦点 Tab 到背景，读屏用户一下就迷失（标准 ARIA dialog 模式；close 时解绑）。
    focusTrap = (e) => {
      if (!dialog || dialog.contains(e.target)) return;
      desc.focus();
    };
    document.addEventListener('focusin', focusTrap, true);
    desc.focus();

    // 点遮罩 = 取消
    root.addEventListener('click', (e) => {
      if (e.target === root) close();
    });
  }

  return { open, close, isOpen: () => !!dialog };
})();
