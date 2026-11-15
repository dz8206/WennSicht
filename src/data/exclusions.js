// WennSicht 排除清单（BP 4.1 / 6.1）
// 命中时内容脚本**完全不初始化**（连消息监听都不建立）——修复行为在任何场景下
// 都不应触碰这些页面。判定顺序见 shouldExcludeUrl：
//   ① 特殊协议：浏览器内部页面 / 扩展页面 / 开发者工具 / 来源视图 / 内联文档
//      —— 无法注入也不属于「网页」范畴，小写化后按前缀直接拦截；
//   ② 协议白名单：只处理 http / https / file（本地 HTML 文件同样可能需要无障碍
//      阅读；file 页需用户在扩展详情页自行开启「允许访问文件网址」才会注入）；
//   ③ 扩展商店域名：Chrome / Edge / Firefox / Opera 的官方商店页面；
//   ④ 银行 / 支付类站点：隐私红线（22 条域名后缀，任何场景都不触碰）。
// 调用方：src/content/content.js 在启动的最前一处调用（含祖先框架判定）。
window.WS_EXCLUSIONS = (() => {
  // ---- ① 特殊协议（小写前缀匹配）----
  const EXCLUDE_SCHEMES = [
    'about:', 'chrome:', 'edge:', 'brave:', 'opera:', 'vivaldi:',
    'chrome-extension:', 'moz-extension:', 'extension:', 'safari-extension:',
    'chrome-untrusted:', 'chrome-search:', 'devtools:', 'view-source:',
    'blob:', 'data:', 'resource:',
  ];

  // ---- ③ 扩展商店域名（host 精确匹配或子域名）----
  const EXCLUDE_HTTP_HOSTS = [
    'chromewebstore.google.com',
    'chrome.google.com',
    'microsoftedge.microsoft.com',
    'addons.mozilla.org',
    'addons.opera.com',
  ];

  // ---- ④ 银行 / 支付（域名后缀，子域名同样命中）----
  const HOST_SUFFIXES = [
    // 银行
    'icbc.com.cn', 'ccb.com', 'abchina.com', 'boc.cn', 'bankcomm.com',
    'psbc.com', 'cmbchina.com', 'spdb.com', 'cib.com.cn', 'cgbchina.com',
    'hxb.com.cn', 'cebbank.com', 'cmbc.com.cn', 'citicbank.com', 'ecitic.com',
    'bos.com.cn', 'bbrace.com', 'bankofbeijing.com.cn',
    // 支付
    'alipay.com', 'tenpay.com', 'unionpay.com', 'paypal.com',
  ];

  // host 与清单的匹配规则：精确相等，或为其子域名。
  // 「.」边界必须有——否则 fakeicbc.com.cn 会因 endsWith('icbc.com.cn') 被误判命中。
  function matchHost(host, list) {
    return list.some((entry) => host === entry || host.endsWith('.' + entry));
  }

  function shouldExcludeUrl(urlString) {
    if (!urlString) return true;

    const lowerUrl = String(urlString).toLowerCase();

    // ① 特殊协议：先于 URL 解析拦截（chrome: / view-source: / blob: 等）
    if (EXCLUDE_SCHEMES.some((scheme) => lowerUrl.startsWith(scheme))) return true;

    try {
      const url = new URL(urlString);

      // ② 协议白名单：只处理 http / https / file（本地文件可能也需要无障碍阅读）
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) return true;

      const host = url.hostname.toLowerCase();

      // ③ 扩展商店（官方页面不处理）
      if (matchHost(host, EXCLUDE_HTTP_HOSTS)) return true;
      // 商店的特定路径（防御性：万一商店迁移域名，路径特征仍能兜住）
      if (host === 'chrome.google.com' && url.pathname.startsWith('/webstore')) return true;
      if (host === 'microsoftedge.microsoft.com' && url.pathname.startsWith('/addons')) return true;

      // ④ 银行 / 支付类站点
      if (matchHost(host, HOST_SUFFIXES)) return true;

      return false; // 不在排除范围内，允许运行
    } catch {
      return true; // URL 解析失败，安全起见排除
    }
  }

  return {
    shouldExcludeUrl,
    isExcluded: shouldExcludeUrl, // 兼容旧调用名（v0.4 之前的调用点）
    EXCLUDE_SCHEMES,
    EXCLUDE_HTTP_HOSTS,
    HOST_SUFFIXES,
  };
})();
