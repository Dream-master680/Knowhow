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

  router.post('/ai', async (req, res) => {
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
