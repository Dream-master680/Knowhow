/**
 * /api/ai —— DeepSeek 代理（公开）
 * ─────────────────────────────────────────────
 * 服务端注入 Authorization（Key 只存在于 .env，不暴露给前端）。
 * 流式：字节级 SSE 透传；非流式：JSON 原样回传；错误码原样透传
 * （前端 ai.js callDeepSeek 已有 401/402/429/5xx 文案映射）。
 */
const express = require('express');

const MAX_MESSAGES = 50;
const MAX_CONTENT = 20000;

module.exports = function () {
  const router = express.Router();

  // ── 简易内存限流：防公网滥用烧 Key（每 IP 每分钟上限，超额 429）──
  const RATE_MAX = 12;                       // 每 IP 每分钟最多 12 次（流式对话足够）
  const RATE_WINDOW_MS = 60 * 1000;
  const hits = new Map();
  function limited(ip) {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      hits.set(ip, { n: 1, resetAt: now + RATE_WINDOW_MS });
      return false;
    }
    rec.n += 1;
    return rec.n > RATE_MAX;
  }
  // 周期性清理过期计数，防 Map 无限增长
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    if (hits.size > 10000) hits.clear();
  }, RATE_WINDOW_MS).unref();

  router.post('/ai', async (req, res) => {
    // 限流（部署在 Nginx 后取 X-Forwarded-For；直连取 socket 地址）
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) || '';
    if (ip && limited(ip)) {
      return res.status(429).json({ error: { message: '请求过于频繁，请稍后再试' } });
    }

    const { messages, model, stream, thinking } = req.body || {};
    const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
    const baseUrl = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

    // 校验参数（防滥用）
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
      return res.status(400).json({ error: { message: 'messages 参数非法' } });
    }
    for (const m of messages) {
      if (!m || typeof m.content !== 'string' || m.content.length > MAX_CONTENT) {
        return res.status(400).json({ error: { message: '单条消息内容过长或格式非法' } });
      }
    }
    if (!apiKey) {
      return res.status(500).json({ error: { message: '服务端未配置 DeepSeek API Key（server/.env）' } });
    }

    const payload = {
      model: model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      messages,
      stream: !!stream
    };
    if (thinking === true) payload.thinking = { type: 'enabled' };
    else if (thinking === false) payload.thinking = { type: 'disabled' };

    let upRes;
    try {
      upRes = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      return res.status(502).json({ error: { message: '无法连接 DeepSeek：' + err.message } });
    }

    // 错误码原样透传，让前端映射生效
    if (!upRes.ok) {
      let detail = '';
      try { const j = await upRes.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* noop */ }
      return res.status(upRes.status).json({ error: { message: detail || '上游错误' } });
    }

    // 非流式：原样回传
    if (!stream) {
      try {
        return res.json(await upRes.json());
      } catch (err) {
        return res.status(502).json({ error: { message: '上游响应解析失败' } });
      }
    }

    // 流式：字节级 SSE 透传
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    req.on('close', () => {
      if (upRes.body && typeof upRes.body.cancel === 'function') upRes.body.cancel();
    });
    try {
      for await (const chunk of upRes.body) res.write(chunk);
      res.end();
    } catch (err) {
      // 客户端断开 / 上游中断
      try { res.end(); } catch (e) { /* noop */ }
    }
  });

  return router;
};
