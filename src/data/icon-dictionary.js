// 阶段 2.2：图标词典 v1（BP 2.2 / 4.3）
//
// 目的：功能性图标**优先用本地词典识别，不调用 AI**。
// 原因（技术背调 🔴）：小模型可能把「提交」描述成「取消」、把「购物车」描述成
// 「垃圾桶」。关键操作图标一旦描述错误，用户会做出错误操作。因此词典命中的
// 图标一律不发往模型，只有词典未命中才降级到 AI。
//
// 匹配键（BP 2.2）：class / id 标记、图片文件名、img alt、aria-label / title。
// SVG path 匹配机制已实现（见 matchSvgPath），但 v1 的 path 表**刻意为空**：
// 从记忆里硬编码 path 字符串有写错的风险，而写错 = 误标图标 = 正是 BP 要避免的
// 致命风险。路径条目必须在实测确认后逐条登记（见 SVG_PATH_HINTS 注释）。
//
// 词典命中后返回中文名称，由管线写入 alt / aria-label。

window.WS_ICON_DICTIONARY = (() => {
  // 每个条目的匹配词（小写）。命中任意一个即为该图标。
  // 词表按「英文标记 + 中文标记」组织，覆盖中文站点常见的 class 命名与文件名。
  const ENTRIES = [
    {
      name: '购物车',
      tokens: ['cart', 'shopping-cart', 'shoppingcart', 'basket', 'trolley', 'gouwuche', '购物车'],
    },
    {
      name: '搜索',
      tokens: ['search', 'magnifier', 'magnify', 'find', 'sousuo', 'searchicon', '搜索'],
    },
    {
      name: '删除',
      tokens: ['delete', 'remove', 'trash', 'bin', 'garbage', 'shanchu', '删除', '移除'],
    },
    {
      name: '关闭',
      tokens: ['close', 'cancel-icon', 'dismiss', 'times', 'guanbi', '关闭'],
    },
    {
      name: '返回',
      tokens: ['back', 'return', 'fanhui', '返回'],
    },
    {
      name: '菜单',
      tokens: ['menu', 'hamburger', 'nav-toggle', 'caidan', '菜单'],
    },
    {
      name: '设置',
      tokens: ['settings', 'setting', 'gear', 'cog', 'shezhi', '设置'],
    },
    {
      name: '收藏',
      tokens: ['favorite', 'favourite', 'bookmark', 'star', 'shoucang', '收藏'],
    },
    {
      name: '分享',
      tokens: ['share', 'fenxiang', '分享'],
    },
    {
      name: '编辑',
      tokens: ['edit', 'pencil', 'bianji', '编辑'],
    },
    {
      name: '上一页',
      tokens: ['prev', 'previous', 'prevpage', 'arrow-left', 'shangyiye', '上一页'],
    },
    {
      name: '下一页',
      tokens: ['next', 'nextpage', 'arrow-right', 'xiayiye', '下一页'],
    },
    {
      name: '展开',
      tokens: ['expand', 'more', 'chevron-down', 'caret-down', 'zhankai', '展开'],
    },
    {
      name: '收起',
      tokens: ['collapse', 'chevron-up', 'caret-up', 'shouqi', '收起'],
    },
    {
      name: '用户',
      tokens: ['user', 'avatar', 'profile', 'account', 'yonghu', '用户'],
    },
    {
      name: '刷新',
      tokens: ['refresh', 'reload', 'sync', 'shuaxin', '刷新'],
    },
    {
      name: '下载',
      tokens: ['download', 'xiazai', '下载'],
    },
    {
      name: '上传',
      tokens: ['upload', 'shangchuan', '上传'],
    },
    {
      name: '筛选',
      tokens: ['filter', 'shaixuan', '筛选'],
    },
    {
      name: '点赞',
      tokens: ['like', 'thumb-up', 'thumbsup', 'dianzan', '点赞'],
    },
  ];

  // 需要拆词的标记来源：class 名、id、文件名
  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .split(/[\s\-_./\\:]+/)
      .filter(Boolean);
  }

  // SVG path 匹配（v1 无条目）：把 path 的 d 做归一化后取前缀比对。
  // 登记新条目时必须用真实站点的 <path d> 实测确认，一次只加一条并验证方向
  // （例如确认「提交」没有被标成「取消」）。
  const SVG_PATH_HINTS = [
    // { name: '搜索', prefix: '(实测确认后的 path 前缀)' },
  ];

  function normalizePath(d) {
    return String(d || '').replace(/[\s,]+/g, ' ').trim().slice(0, 64);
  }

  // 从元素本身及其可用的文本标记中提取候选 token
  function gatherTokens(el) {
    const tokens = [];
    const push = (v) => {
      for (const t of tokenize(v)) tokens.push(t);
    };

    push(el.getAttribute('class'));
    push(el.getAttribute('id'));

    // <img src> 的文件名部分（不含扩展名）
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (src) {
      try {
        const base = src.split('?')[0].split('#')[0].split('/').pop() || '';
        push(base.replace(/\.[a-z0-9]+$/i, ''));
      } catch {
        /* 忽略无法解析的地址 */
      }
    }

    // 已有的可访问名称（仅作为识别线索，不会被覆盖 —— S3/S4）
    push(el.getAttribute('aria-label'));
    push(el.getAttribute('title'));
    push(el.getAttribute('alt'));

    return tokens;
  }

  // 单个词条 token 是否命中。三种匹配方式各有原因（2026-09-28 单测实测暴露过问题）：
  //   - ASCII 单词：**精确 token** 匹配 —— 否则 cart 会命中 carrot、like 会命中 dislike；
  //   - 含连字符的多词（thumb-up / arrow-left / chevron-down）：class 名会按连字符拆开，
  //     因此拼回"带连字符边界"的串再整体比对（'dislike-btn' 不会命中 'like'）；
  //   - 中文词：允许**子串** —— 中文没有词边界，aria-label/title 常写成"返回上一页""关闭弹窗"，
  //     只做整串相等会全部漏掉（实测：title="返回上一页" 曾完全识别不出）。
  const CJK_RE = /[\u4e00-\u9fff]/;

  function tokenMatches(tokens, paddedJoined, token) {
    if (CJK_RE.test(token)) return tokens.some((t) => t.includes(token));
    if (token.includes('-')) return paddedJoined.includes('-' + token + '-');
    return tokens.includes(token);
  }

  // 返回命中的图标名称；未命中返回 null
  function lookup(el) {
    const tokens = gatherTokens(el);
    if (!tokens.length) return null;
    const paddedJoined = '-' + tokens.join('-') + '-';

    for (const entry of ENTRIES) {
      for (const token of entry.tokens) {
        if (tokenMatches(tokens, paddedJoined, token)) return entry.name;
      }
    }
    return null;
  }

  // SVG 路径查询（v1 表为空，返回 null）
  function lookupSvgPath(d) {
    if (!SVG_PATH_HINTS.length) return null;
    const norm = normalizePath(d);
    for (const hint of SVG_PATH_HINTS) {
      if (norm.startsWith(hint.prefix)) return hint.name;
    }
    return null;
  }

  return { lookup, lookupSvgPath, ENTRIES, SVG_PATH_HINTS };
})();
