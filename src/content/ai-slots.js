// AI 双档读取口径（2026-10-04 改名：main→primary 前置档 / back→default 默认档）
//
// 口径：primary 前置档「可留空」（留空即只用 default）；default 默认档「必填」
//（AI 功能基线；决策模型分类判定永走 default）。内容脚本各模块只做「配置齐备性」
// 早退判断（密钥本体在 SW 侧解密校验），统一经由本模块读键。
//
// 为什么必须统一：2026-10-04 改名后 6 个内容模块仍各写各的 `ai.main / ai.back`
// 旧键判断——旧键已不存在，双双 undefined → AI 被静默禁用（verify-fixture
// 用例 28「周边文本推测」为此回归，其余用例恰好都是「AI 关闭也成立」的断言，
// 没有暴露）。集中到一处后，改名/兼容只改这里。
window.WS_AI_SLOTS = (() => {
  const has = (slot, field) => !!(slot && slot.baseUrl && slot[field]);

  // primary 前置档（可留空）：新名优先，兼容 v1 旧名 main
  function primary(cfg) {
    return cfg?.primary ?? cfg?.main ?? null;
  }

  // default 默认档（必填）：新名 → 旧名 back → v0 平铺单档（顶层 baseUrl 存在即视作
  // 默认档），与 ai.js migrateLegacyConfig 的归位口径一致
  function getDefault(cfg) {
    if (cfg?.default) return cfg.default;
    if (cfg?.back) return cfg.back;
    return cfg?.baseUrl ? cfg : null;
  }

  return {
    primary,
    default: getDefault,
    // 「智能场景解析增强」主开关（2026-11-03 新增，唯一读口）。
    // 为什么要有它：内容脚本读的是**原始存储**，而出厂默认值是写在 ai.js 的
    // DEFAULT_CONFIG 里的——用户没手动保存过时存储里没有 enabled 字段，
    // 各模块各自写 `!!cfg.enabled` 就会把「设置页明明勾着」判成关闭，
    // 页面播「请先在设置页启用…」，用户怎么点都没用（0.2.0 已发布版本的实锤缺陷）。
    // 口径：存储里是布尔就照它（用户显式关过就是关）；没写则按出厂口径——
    // 已选公益中转、或已经存过任一套接口配置，都视作开启（设置页正是这样显示勾选态的）。
    enabled(cfg) {
      if (typeof cfg?.enabled === 'boolean') return cfg.enabled;
      return cfg?.provider === 'builtin-relay' || !!getDefault(cfg)?.baseUrl;
    },
    // 「任一档配齐 接口 + 视觉模型」即可处理图片/图表（primary 优先、失败落 default，
    // 由 SW 路由负责；此处只判断配置齐备性）
    visionReady(cfg) {
      return has(primary(cfg), 'visionModel') || has(getDefault(cfg), 'visionModel');
    },
    // 文本能力：页面摘要 / 页面问答
    textReady(cfg) {
      return has(primary(cfg), 'textModel') || has(getDefault(cfg), 'textModel');
    },
    // 决策模型（链接意图等分类判定）：永走默认档（前置档不承担）
    decisionReady(cfg) {
      const d = getDefault(cfg);
      // 兼容升级前保存的旧字段名 jevModel：内容脚本读的是**原始存储**、
      // 不经过 SW 的迁移落盘，升级窗口内必须先认旧名，否则 AI 被静默禁用。
      return has(d, 'decisionModel') || has(d, 'jevModel');
    },
  };
})();
