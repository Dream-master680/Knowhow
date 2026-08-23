/**
 * KnowHow AI 配置
 * ─────────────────────────────────────────────
 * 在这里填入你的 DeepSeek API Key：
 *   1. 打开 https://platform.deepseek.com 登录（需充值）
 *   2. 左侧「API Keys」→ 创建 → 复制以 sk- 开头的 Key
 *   3. 粘贴到下方 DEEPSEEK_API_KEY
 *
 * ⚠️ 安全提醒：这是纯前端方案，Key 会暴露给所有访问者。
 * 目前仅适合自用 / 演示。公开上线前需改用后端代理保护 Key。
 */
window.AI_CONFIG = {
  /* DeepSeek API Key（sk- 开头） */
  DEEPSEEK_API_KEY: 'sk-6ffea145193a4eacaabcb6967ef1658b',

  /* 模型：deepseek-v4-flash（快、便宜）或 deepseek-v4-pro（更强、约3倍价） */
  DEEPSEEK_MODEL: 'deepseek-v4-flash',

  /* API 地址（一般无需修改） */
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com'
};
