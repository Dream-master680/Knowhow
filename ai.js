/**
 * KnowHow AI 集成层
 * ─────────────────────────────────────────────
 * 1) callDeepSeek  —— DeepSeek API 调用（OpenAI 兼容协议，支持流式/非流式）
 * 2) escapeHtml   —— HTML 转义工具（全站渲染安全必需）
 * 3) AI 悬浮助手    —— 全站右下角聊天窗口（自动注入 DOM，无需改 app.js）
 */
(function () {
  'use strict';

  const CONFIG = window.AI_CONFIG || {};
  const BASE_URL = (CONFIG.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const ENDPOINT = BASE_URL + '/chat/completions';
  const DEFAULT_MODEL = CONFIG.DEEPSEEK_MODEL || 'deepseek-v4-flash';

  /* ── HTML 转义 ─────────────────────────────── */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── 流式响应解析（SSE）────────────────────── */
  async function consumeStream(resp, onChunk) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
          if (delta.reasoning_content && typeof onChunk === 'function') {
            onChunk(delta.reasoning_content, 'reasoning');
          }
          if (delta.content) {
            full += delta.content;
            if (typeof onChunk === 'function') onChunk(delta.content, 'content');
          }
        } catch (e) { /* 忽略无法解析的分片 */ }
      }
    }
    return { ok: true, text: full };
  }

  /* ── 核心调用 ──────────────────────────────── */
  /**
   * 调用 DeepSeek。
   * @param {Array} messages  OpenAI 格式消息数组 [{role:'system'|'user'|'assistant', content}]
   * @param {Object} opts
   *   - stream  {boolean}  是否流式（默认 false）
   *   - onChunk {function(piece, kind)} 流式回调，kind='content'|'reasoning'
   *   - model   {string}   覆盖模型
   *   - thinking {boolean|undefined} 控制思考模式（默认由模型决定；传 false 强制关闭）
   * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
   */
  async function callDeepSeek(messages, opts) {
    opts = opts || {};
    const apiKey = String(CONFIG.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) {
      return { ok: false, error: '未配置 DeepSeek API Key：请打开 config.js 填写 DEEPSEEK_API_KEY' };
    }

    const payload = {
      model: opts.model || DEFAULT_MODEL,
      messages: Array.isArray(messages) ? messages : [],
      stream: !!opts.stream
    };
    if (opts.thinking === false) payload.thinking = { type: 'disabled' };
    else if (opts.thinking === true) payload.thinking = { type: 'enabled' };

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      return { ok: false, error: '网络错误：' + err.message };
    }

    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* noop */ }
      let msg = '请求失败（HTTP ' + resp.status + '）';
      if (resp.status === 401) msg = 'DeepSeek API Key 无效，请检查 config.js';
      else if (resp.status === 402) msg = 'DeepSeek 账户余额不足，请到 platform.deepseek.com 充值';
      else if (resp.status === 429) msg = '请求过于频繁，请稍后再试';
      else if (resp.status >= 500) msg = 'DeepSeek 服务暂时不可用，请稍后再试';
      if (detail) msg += '：' + detail;
      return { ok: false, error: msg };
    }

    if (opts.stream) {
      try {
        return await consumeStream(resp, opts.onChunk);
      } catch (err) {
        return { ok: false, error: '流式读取失败：' + err.message };
      }
    }

    try {
      const data = await resp.json();
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      return { ok: true, text: text };
    } catch (err) {
      return { ok: false, error: '响应解析失败：' + err.message };
    }
  }

  /* ── 全站悬浮 AI 助手 ──────────────────────── */
  const WIDGET = {
    el: null,
    open: false,
    history: [],   // [{role, content}]
    sending: false
  };

  function widgetSend() {
    const input = WIDGET.el.querySelector('.ai-chat-input');
    const text = (input.value || '').trim();
    if (!text || WIDGET.sending) return;
    input.value = '';
    widgetAppendUser(text);
    widgetStreamReply();
  }

  function widgetAppendUser(text) {
    WIDGET.history.push({ role: 'user', content: text });
    const box = WIDGET.el.querySelector('.ai-chat-messages');
    const row = document.createElement('div');
    row.className = 'ai-chat-msg ai-msg-user';
    row.textContent = text;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  async function widgetStreamReply() {
    const box = WIDGET.el.querySelector('.ai-chat-messages');
    const row = document.createElement('div');
    row.className = 'ai-chat-msg ai-msg-assistant';
    row.innerHTML = '<span class="spinner"></span>';
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;

    WIDGET.history.push({ role: 'assistant', content: '' });
    const holder = WIDGET.history[WIDGET.history.length - 1];

    let pending = '';
    const flush = () => {
      row.textContent = pending;
      box.scrollTop = box.scrollHeight;
    };

    const system = [
      '你的名字是「法律小Know」，是 KnowHow 法律新媒体平台的 AI 助手，一个服务人民的法律引导员。',
      '人设：专业、自信、有担当的法律引导员，亲切、耐心、接地气，专为普通老百姓服务，把法律讲成人人都懂的话。',
      '你的核心作用是"桥梁"：帮助不懂法律的老百姓把诉求表达得更清晰，引导他们用法律维护自身权益。',
      '你熟知本站 KnowHow 的各板块，回答时会结合本站服务引导用户去对的地方：',
      '- 影视中心：普法纪录片与法律知识视频，适合想看案例、补常识的用户；',
      '- 时政要闻：最新法律政策解读；',
      '- 论坛交流：可发帖讨论、寻求专业律师在线答疑；',
      '- 法律时效：查询法律条文变更与生效时间；',
      '- 律师推广：查找专业律师名片、预约法律咨询；',
      '- 法律互动：提交法律咨询与问答。',
      '当用户的问题适合某个板块时，主动告诉他"你可以到本站 xxx 板块……"给出可落地的下一步。',
      '与豆包等通用 AI 助手不同：你不闲聊、不答与民生法律无关的话题，只专注帮老百姓解决身边的法律问题。',
      '当用户描述生活中的麻烦（劳动、租房、消费、婚姻家事、欠款、侵权、行政投诉等）时：',
      '1) 先帮他把事情理清楚——发生了什么、对方是谁、他想要什么结果；',
      '2) 用大白话指出这属于哪类法律问题、他大致拥有哪些权利；',
      '3) 给出可操作、可落地的建议（如保留哪些证据、可向哪个机构反映、大致可主张什么）；',
      '4) 提醒法律程序有时间限制和成本；涉及重大利益，自信地指引到本站「律师推广」板块寻求专业律师支持。',
      '你是专业可信的法律引导员：回答要明确、具体、笃定，给出清晰结论和行动步骤，不自我怀疑，不做无谓的免责声明。',
      '回答简洁、结构清晰，优先使用中文。',
      '输出要求：一律使用纯文本中文大白话，严禁使用 Markdown 或任何格式符号（不要用 **、#、*、-、>、反引号、[ ] 等标记）；需要分点列步骤时用"第一/第二/第三"或"第一步/第二步"，用普通换行分段，方便在聊天窗口直接阅读。'
    ].join('\n');

    WIDGET.sending = true;
    const messages = [{ role: 'system', content: system }].concat(
      WIDGET.history.map(m => ({ role: m.role, content: m.content || '' }))
    );

    const res = await callDeepSeek(messages, {
      stream: true,
      thinking: false,
      onChunk: (piece, kind) => {
        if (kind === 'content') {
          holder.content += piece;
          pending += piece;
          flush();
        }
      }
    });

    WIDGET.sending = false;
    if (!res.ok) {
      pending = '⚠️ ' + (res.error || '请求失败');
      flush();
      WIDGET.history.pop(); // 移除失败的空助手回复
    } else {
      holder.content = pending;
    }
  }

  function widgetToggle() {
    const panel = WIDGET.el.querySelector('.ai-chat-panel');
    const fab = WIDGET.el.querySelector('.ai-chat-fab');
    WIDGET.open = !WIDGET.open;
    panel.classList.toggle('open', WIDGET.open);
    fab.classList.toggle('active', WIDGET.open);
    if (WIDGET.open) WIDGET.el.querySelector('.ai-chat-input').focus();
  }

  function initWidget() {
    if (WIDGET.el || document.getElementById('aiChatWidget')) return;

    const host = document.createElement('div');
    host.id = 'aiChatWidget';
    host.innerHTML =
      '<button class="ai-chat-fab" type="button" aria-label="打开 AI 助手">AI</button>' +
      '<div class="ai-chat-panel" role="dialog" aria-label="AI 助手">' +
      '  <div class="ai-chat-header">' +
      '    <div class="ai-chat-title">⚖️ 法律小Know</div>' +
      '    <button class="ai-chat-close" type="button" aria-label="关闭">×</button>' +
      '  </div>' +
      '  <div class="ai-chat-messages">' +
      '    <div class="ai-chat-msg ai-msg-assistant">你好，我是「法律小Know」，KnowHow 法律平台的专业法律引导员。<br>你可以用大白话告诉我你的麻烦（工资被拖欠、租房退押金、买到假货…），我会直接告诉你：这是什么问题、该怎么维权、第一步做什么，也能带你到本站相关板块。</div>' +
      '  </div>' +
      '  <div class="ai-chat-input-row">' +
      '    <input class="ai-chat-input" type="text" placeholder="输入问题，回车发送…" autocomplete="off" />' +
      '    <button class="ai-chat-send" type="button">发送</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(host);
    WIDGET.el = host;

    host.querySelector('.ai-chat-fab').addEventListener('click', widgetToggle);
    host.querySelector('.ai-chat-close').addEventListener('click', widgetToggle);
    host.querySelector('.ai-chat-send').addEventListener('click', widgetSend);
    host.querySelector('.ai-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') widgetSend();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }

  /* ── 导出 ──────────────────────────────────── */
  window.AI = {
    callDeepSeek,
    escapeHtml,
    config: CONFIG
  };
  window.escapeHtml = escapeHtml;
})();
