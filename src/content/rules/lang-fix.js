// 阶段 3.6：语言标注自动适配（纯规则，零 AI —— BP 4.2 精神）
//
// 问题（2026-09-29 用户实测）：大量真实中文网站 <html> 不标 lang。NVDA 的
// 「自动切换语言」会按 lang 决定用什么合成器嗓音：无 lang 文档在部分配置下
// 被当作默认/英文语音处理，中文内容用错嗓音甚至静音跳过（听感=「标题2级」
// 有头没名字、h/b 定位到元素却听不到内容）。补充 lang 是浏览器生态的
// 标准修复手段，屏幕阅读器据此选择正确语音。
//
// 做法（保守，S3「不覆盖已有语义」铁律）：
//   - 仅当 documentElement 完全没有 lang 属性时才补写；已有 lang（哪怕
//     疑似标错，如 zh 页面标 en）一律不动 —— 纠正已有标注属作者意图层面，
//     静态规则误伤代价高，留给后续反馈驱动。
//   - 检测信号 = 正文汉字占比：取可见文本样本统计 CJK 表意字符占比，
//     ≥ LANG_THRESHOLD 认定为中文页。不用 AI、不用 meta 声明
//     （content-language 标签早已废弃且常缺失，不可靠）。
//   - 样本采集跳过本扩展注入物、script/style/noscript/template/iframe、
//     aria-hidden 子树与不可见元素，与屏幕阅读器实际听到的文本对齐。
//
// 还原：经 ctx.setAttr 写入 journal，关闭增强时由编排器统一移除。
// 幂等：documentElement 没有 lang 时才会进 journal，重复执行天然无副作用。
// SPA 注意：路由切换不改 <html> 属性，本规则无需参与增量扫描，只在
// applyAll / 路由全量重扫时执行（无子树变体， roots 参数仅接受并忽略）。
window.WS_RULES = window.WS_RULES || {};

WS_RULES.langFix = async (ctx) => {
  const root = document.documentElement;
  if (!root || root.hasAttribute('lang')) return; // S3：已有标注一律不动

  const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/; // CJK 统一表意文字（含扩展A与兼容）
  const LATIN_RE = /[A-Za-z\u00C0-\u024F]/; // 拉丁字母（含带变音符）
  const SKIP_SEL =
    'script, style, noscript, template, iframe, svg, code, pre, ' +
    '[data-ws-ignore-obs], [aria-hidden="true"]';

  // 采集可见文本样本：上限字符数，足够判定且远低于大页面总文本量
  const LIMIT = 4000;
  const sample = { han: 0, latin: 0, other: 0, total: 0 };
  let enough = false;

  const walk = (el, depth) => {
    if (enough || depth > 30) return;
    for (const node of el.childNodes) {
      if (enough) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || '';
        for (const ch of text) {
          if (!/\S/.test(ch)) continue; // 跳过空白
          sample.total++;
          if (CJK_RE.test(ch)) sample.han++;
          else if (LATIN_RE.test(ch)) sample.latin++;
          else sample.other++;
          if (sample.total >= LIMIT) { enough = true; return; }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // 嵌在表单控件里的文本（label/option/placeholder 语义）也算页面语言信号
        if (node.matches?.(SKIP_SEL)) continue;
        let cs = null;
        try { cs = getComputedStyle(node); } catch { /* 断开子树等异常按可见处理 */ }
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        walk(node, depth + 1);
      }
    }
  };

  walk(document.body || root, 0);
  if (sample.total < 50) return; // 文本太少不可判定：不动（首页加载中的 SPA 等）

  // 判定：汉字显著占多数才补 zh。拉丁字符占比高（中英混排的代码站、
  // 英文站）时宁可不动 —— 补错 lang 比缺 lang 更糟（S3 精神）。
  const hanRatio = sample.han / sample.total;
  if (hanRatio >= 0.3 && sample.han > sample.latin) {
    ctx.setAttr(root, 'lang', 'zh-CN');
  }
};
