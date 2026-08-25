/**
 * KnowHow AI 配置
 * ─────────────────────────────────────────────
 * ⚠️ 安全提醒：真实 DeepSeek API Key 已移到服务端 server/.env（后端代理）。
 * 浏览器端不再持有 Key：server/routes/ai.js 会注入 Authorization 头。
 * 配置 Key 请编辑 server/.env 的 DEEPSEEK_API_KEY（不要在仓库里提交真实 Key）。
 */
window.AI_CONFIG = {
  /* DeepSeek API Key —— 已移至服务端 .env，此处不再需要（留空） */
  DEEPSEEK_API_KEY: '',

  /* 模型：deepseek-v4-flash（快、便宜）或 deepseek-v4-pro（更强、约3倍价） */
  DEEPSEEK_MODEL: 'deepseek-v4-flash',

  /* API 地址（一般无需修改） */
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com'
};
