// WennSicht 内容脚本注册清单与注册 ID 约定（共享数据）
// 被两处使用：
//   - src/options/options.js：用户添加站点 / 开启全局时注册内容脚本
//   - src/background/service-worker.js：冷启动时自愈注册（见下）
// （原第三处 dev-watcher（开发期监测）已随 2026-10-04 发布清理移出本目录）
// 加载方式：Service Worker 经 importScripts、设置页经 <script> 标签；
// 统一挂在 globalThis 上（两种环境都可用）。
globalThis.WS_CONTENT_FILES = [
  'src/data/exclusions.js',
  'src/data/icon-dictionary.js',
  // 会话 74：必须最先注入 —— 后面所有脚本的播报都要用「用户实际绑定的快捷键」
  'src/content/shortcut-text.js',
  'src/content/sanitize.js',
  'src/content/ai-privacy.js',
  'src/content/ai-slots.js', // AI 双档读键口径（2026-10-04 改名后的唯一读口）
  'src/content/rules/noise-cleaner.js',
  'src/content/rules/lang-fix.js',
  'src/content/rules/heading-fixer.js',
  'src/content/rules/interactive-semantics.js',
  'src/content/rules/heading-hierarchy.js', // 层级压平/多h1降级（2026-11-03 会话 45）
  'src/content/rules/landmarks.js',
  'src/content/image-pipeline.js',
  'src/content/shadow-scan.js',
  'src/content/spa-watcher.js',
  'src/content/scene.js',
  'src/content/summarizer.js',
  'src/content/link-intent.js',
  'src/content/chart-table.js',
  'src/content/table-parser.js',
  'src/content/form-helper.js',
  'src/content/feedback.js',
  'src/content/page-qa.js',
  'src/content/image-longdesc.js',
  'src/content/layout-map.js',
  'src/content/live-updates.js',
  'src/content/position-memory.js',
  'src/content/content.js',
];

// 注册 ID 约定：全局开关用固定 ID；站点级用 origin 转换。
// 注意：Chrome 内部存储时可能给动态脚本 id 加 `_dc_` 前缀
//（实测注册记录形如 "_dc_wennsicht-global"），比对时需容忍。
globalThis.WS_GLOBAL_SCRIPT_ID = 'wennsicht-global';

globalThis.WS_siteScriptId = (origin) =>
  'wennsicht-site-' + origin.replace(/[^a-z0-9]+/gi, '-');

// 容忍 `_dc_` 内部前缀的归属判断
globalThis.WS_isOwnScriptId = (id) =>
  id === globalThis.WS_GLOBAL_SCRIPT_ID ||
  id === '_dc_' + globalThis.WS_GLOBAL_SCRIPT_ID ||
  /^(?:_dc_)?wennsicht-site-/.test(id);