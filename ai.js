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

  /* ── AI 咨询个性化公共能力（TTS 朗读 / 复制 / 时间 / 消息模板 / 快捷问题）── */
  const tts = { voice: null, activeBtn: null, token: 0 };

  // 初始化 TTS：getVoices 首次返回空，需等 voiceschanged 后再取中文音色
  function initTTS() {
    if (!window.speechSynthesis) return;
    const pick = () => {
      const list = window.speechSynthesis.getVoices();
      const zh = (list || []).filter(v => /^zh/i.test(v.lang || ''));
      tts.voice = zh.find(v => /CN/i.test(v.lang)) || zh[0] || null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
  }

  function stopSpeak() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (tts.activeBtn) {
      tts.activeBtn.classList.remove('active');
      tts.activeBtn.textContent = '🔊 朗读';
      tts.activeBtn = null;
    }
    tts.token++;
  }

  // 朗读：点同一按钮再点=停止；点别的按钮=先停旧再播新；长文本按句切分防 Chrome 截断
  function speak(text, btn) {
    const synth = window.speechSynthesis;
    if (!synth || !text || !String(text).trim()) return;
    if (tts.activeBtn === btn) { stopSpeak(); return; }
    const myToken = ++tts.token;
    synth.cancel();
    if (tts.activeBtn) tts.activeBtn.classList.remove('active');

    const raw = String(text).trim();
    const parts = raw.split(/(?<=[。！？!?…；;\n])/).filter(Boolean);
    const chunks = [];
    let buf = '';
    for (const p of parts) {
      if (buf.length + p.length > 120 && buf) { chunks.push(buf); buf = ''; }
      buf += p;
    }
    if (buf) chunks.push(buf);
    if (!chunks.length) chunks.push(raw);

    let ci = 0;
    tts.activeBtn = btn;
    btn.classList.add('active');
    btn.textContent = '⏹ 停止';
    const step = () => {
      if (myToken !== tts.token) return;
      if (ci >= chunks.length) { stopSpeak(); return; }
      const u = new SpeechSynthesisUtterance(chunks[ci++]);
      if (tts.voice) u.voice = tts.voice;
      u.lang = (tts.voice && tts.voice.lang) || 'zh-CN';
      u.onend = step;
      u.onerror = () => { if (myToken === tts.token) stopSpeak(); };
      synth.resume();
      synth.speak(u);
    };
    setTimeout(step, 50); // Chrome cancel→speak 竞态兜底
  }

  // 复制文本，clipboard 不可用时回退 execCommand
  function copyText(text, btn) {
    const val = String(text == null ? '' : text);
    if (!val) return;
    const done = () => {
      if (btn) {
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
      }
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = val;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) { /* ignore */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(val).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  // 时间格式：当天 HH:MM，跨天加 M/D 前缀；无时间戳返回空串（兼容旧数据）
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  // 统一消息气泡模板：外层行 + 头像 + 角色/时间 + 气泡正文 + 操作栏。
  // kind='widget' 用悬浮助手气泡类；默认用咨询页气泡类（保住两套主题既有覆盖）。
  // 流式时只改 .ai-msg-text 的 textContent，外层与按钮永不重建。
  function messageHTML(role, contentHtml, ts, kind) {
    const isUser = role === 'user';
    const bubbleCls = kind === 'widget'
      ? (isUser ? 'ai-chat-msg ai-msg-user' : 'ai-chat-msg ai-msg-assistant')
      : (isUser ? 'ai-consult-msg ai-consult-user' : 'ai-consult-msg ai-consult-bot');
    const avatar = isUser ? '👤' : '⚖️';
    const roleName = isUser ? '你' : '法律小Know';
    const time = fmtTime(ts);
    return '<div class="ai-msg-row ' + (isUser ? 'user' : 'bot') + '">' +
      '<div class="ai-msg-avatar" aria-hidden="true">' + avatar + '</div>' +
      '<div class="ai-msg-main">' +
        '<div class="ai-msg-meta"><span class="ai-msg-role">' + roleName + '</span><span class="ai-msg-time">' + time + '</span></div>' +
        '<div class="' + bubbleCls + '"><span class="ai-msg-text">' + (contentHtml || '') + '</span></div>' +
        '<div class="ai-msg-actions">' +
          '<button type="button" class="ai-msg-btn ai-msg-speak" disabled>🔊 朗读</button>' +
          '<button type="button" class="ai-msg-btn ai-msg-copy" disabled>📋 复制</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // 启用一行消息的朗读/复制按钮并绑定事件
  function bindMsgActions(row, speakText, copyVal) {
    const s = row.querySelector('.ai-msg-speak');
    const c = row.querySelector('.ai-msg-copy');
    if (s) { s.disabled = false; s.addEventListener('click', () => speak(speakText, s)); }
    if (c) { c.disabled = false; c.addEventListener('click', () => copyText(copyVal, c)); }
  }

  // 常用问题快捷入口（咨询页全量、悬浮助手取前 4 条）
  const quickQuestions = [
    '工资被拖欠怎么办？',
    '租房到期不退押金怎么办？',
    '买到假货怎么维权？',
    '离婚了财产怎么分？',
    '别人借钱不还怎么办？',
    '被裁员了能拿赔偿吗？'
  ];

  /* ── 全站悬浮 AI 助手 ──────────────────────── */
  // 历史按用户隔离：切换账号各自独立 key，避免串号
  function widgetUserId() {
    try {
      const u = JSON.parse(localStorage.getItem('ln_auth_v1') || 'null');
      return (u && u.id) ? String(u.id) : 'guest';
    } catch (e) { return 'guest'; }
  }
  function widgetKey() { return 'ln_ai_widget_history_' + widgetUserId(); }

  function loadWidgetHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(widgetKey()) || '[]');
      return Array.isArray(arr) ? arr.slice(-30) : [];
    } catch (e) { return []; }
  }

  function persistWidget() {
    try { localStorage.setItem(widgetKey(), JSON.stringify(WIDGET.history.slice(-30))); } catch (e) { /* ignore */ }
  }

  const WIDGET = {
    el: null,
    open: false,
    history: [],   // [{role, content, ts}]
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
    const now = Date.now();
    WIDGET.history.push({ role: 'user', content: text, ts: now });
    persistWidget();
    const box = WIDGET.el.querySelector('.ai-chat-messages');
    const row = document.createElement('div');
    row.innerHTML = messageHTML('user', escapeHtml(text), now, 'widget');
    box.appendChild(row);
    bindMsgActions(row, text, text);
    box.scrollTop = box.scrollHeight;
  }

  async function widgetStreamReply() {
    const box = WIDGET.el.querySelector('.ai-chat-messages');
    const row = document.createElement('div');
    row.innerHTML = messageHTML('assistant', '', null, 'widget');
    const textNode = row.querySelector('.ai-msg-text');
    const speakBtn = row.querySelector('.ai-msg-speak');
    const copyBtn = row.querySelector('.ai-msg-copy');
    textNode.innerHTML = '<span class="spinner"></span>';
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;

    WIDGET.history.push({ role: 'assistant', content: '', ts: Date.now() });
    const holder = WIDGET.history[WIDGET.history.length - 1];

    let pending = '';
    const flush = () => {
      textNode.textContent = pending;
      box.scrollTop = box.scrollHeight;
    };

    const system = [
      '你的名字是「法律小Know」，是 KnowHow 法律新媒体平台的 AI 助手，一个服务人民的法律引导员。',
      '人设：专业、自信、有担当的法律引导员，亲切、耐心、接地气，专为普通老百姓服务，把法律讲成人人都懂的话。',
      '你的核心作用是"桥梁"：帮助不懂法律的老百姓把诉求表达得更清晰，引导他们用法律维护自身权益。',
      '你熟知本站 KnowHow 的各板块，回答时会结合本站服务引导用户去对的地方：',
      '- 影视中心：普法纪录片与法律知识视频，适合想看案例、补常识的用户；',
      '- 法治头条：最新法律政策解读；',
      '- 论坛交流：可发帖讨论、寻求专业律师在线答疑；',
      '- 民法典：在线阅读《中华人民共和国民法典》精选法条，支持全文检索；',
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
      persistWidget();
      copyBtn.disabled = false;
      copyBtn.addEventListener('click', () => copyText(pending, copyBtn));
    } else {
      holder.content = pending;
      persistWidget();
      bindMsgActions(row, pending, pending);
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

  const WIDGET_WELCOME = '你好，我是「法律小Know」，KnowHow 法律平台的专业法律引导员。\n你可以用大白话告诉我你的麻烦（工资被拖欠、租房退押金、买到假货…），我会直接告诉你：这是什么问题、该怎么维权、第一步做什么，也能带你到本站相关板块。';

  function initWidget() {
    if (WIDGET.el || document.getElementById('aiChatWidget')) return;

    const host = document.createElement('div');
    host.id = 'aiChatWidget';
    host.innerHTML =
      '<button class="ai-chat-fab" type="button" aria-label="打开 AI 助手">AI</button>' +
      '<div class="ai-chat-panel" role="dialog" aria-label="AI 助手">' +
      '  <div class="ai-chat-header">' +
      '    <div class="ai-chat-title">⚖️ 法律小Know</div>' +
      '    <button class="ai-chat-clear" type="button" aria-label="清空对话" title="清空对话">🗑</button>' +
      '    <button class="ai-chat-close" type="button" aria-label="关闭">×</button>' +
      '  </div>' +
      '  <div class="ai-chat-chips" aria-label="常用问题"></div>' +
      '  <div class="ai-chat-messages"></div>' +
      '  <div class="ai-chat-input-row">' +
      '    <input class="ai-chat-input" type="text" placeholder="输入问题，回车发送…" autocomplete="off" />' +
      '    <button class="ai-chat-send" type="button">发送</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(host);
    WIDGET.el = host;

    // 历史持久化：恢复上次会话
    WIDGET.history = loadWidgetHistory();

    // 常用问题快捷入口
    const chipsWrap = host.querySelector('.ai-chat-chips');
    if (chipsWrap) {
      chipsWrap.innerHTML = quickQuestions.slice(0, 4)
        .map(q => '<button type="button" class="ai-msg-chip" data-q="' + escapeHtml(q) + '">' + escapeHtml(q) + '</button>')
        .join('');
    }

    // 欢迎语或历史消息
    const msgBox = host.querySelector('.ai-chat-messages');
    if (WIDGET.history.length) {
      msgBox.innerHTML = WIDGET.history.map(m => messageHTML(m.role, escapeHtml(m.content || ''), m.ts, 'widget')).join('');
      msgBox.querySelectorAll('.ai-msg-row').forEach((row, i) => {
        const m = WIDGET.history[i];
        bindMsgActions(row, m.content || '', m.content || '');
      });
    } else {
      msgBox.innerHTML = messageHTML('assistant', escapeHtml(WIDGET_WELCOME), null, 'widget');
    }

    host.querySelector('.ai-chat-fab').addEventListener('click', widgetToggle);
    host.querySelector('.ai-chat-close').addEventListener('click', widgetToggle);
    host.querySelector('.ai-chat-send').addEventListener('click', widgetSend);
    host.querySelector('.ai-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') widgetSend();
    });
    host.querySelector('.ai-chat-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.ai-msg-chip');
      if (chip) {
        const input = host.querySelector('.ai-chat-input');
        input.value = chip.getAttribute('data-q');
        widgetSend();
      }
    });
    host.querySelector('.ai-chat-clear').addEventListener('click', () => {
      if (WIDGET.sending) return;
      if (!WIDGET.history.length) return;
      if (!confirm('确定清空悬浮助手的全部对话记录吗？')) return;
      stopSpeak();
      WIDGET.history.length = 0;
      persistWidget();
      host.querySelector('.ai-chat-messages').innerHTML = messageHTML('assistant', escapeHtml(WIDGET_WELCOME), null, 'widget');
    });
  }

  initTTS();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
  // 路由切换时停止朗读，避免切页后残留语音
  window.addEventListener('hashchange', stopSpeak);

  // 账号切换（kh:authchange）时重载悬浮助手历史，防止上一个账号的数据串号
  window.addEventListener('kh:authchange', function () {
    WIDGET.history = loadWidgetHistory();
    const msgBox = WIDGET.el && WIDGET.el.querySelector('.ai-chat-messages');
    if (!msgBox) return;
    if (WIDGET.history.length) {
      msgBox.innerHTML = WIDGET.history.map(m => messageHTML(m.role, escapeHtml(m.content || ''), m.ts, 'widget')).join('');
      msgBox.querySelectorAll('.ai-msg-row').forEach((row, i) => {
        const m = WIDGET.history[i];
        bindMsgActions(row, m.content || '', m.content || '');
      });
    } else {
      msgBox.innerHTML = messageHTML('assistant', escapeHtml(WIDGET_WELCOME), null, 'widget');
    }
  });

  /* ── 导出 ──────────────────────────────────── */
  window.AI = {
    callDeepSeek,
    escapeHtml,
    config: CONFIG,
    speak,
    stopSpeak,
    copyText,
    fmtTime,
    messageHTML,
    quickQuestions
  };
  window.escapeHtml = escapeHtml;
})();
