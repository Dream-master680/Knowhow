/**
 * KnowHow 同步桥（sync-bridge）
 * ─────────────────────────────────────────────
 * 让全站 ~1 万行「同步读 localStorage」的代码零改动地获得服务器持久化：
 *  · 内存 cache 镜像 localStorage，read/write 仍同步
 *  · 写 → 立即落 cache + localStorage（保离线行为），后台防抖上送服务器
 *  · 启动 → 先推 dirty（离线期间的写入）→ 再拉 /api/bootstrap 权威数据覆盖
 *  · 服务器不可达 → 静默降级为纯 localStorage（现状不变，双击打开也能用）
 *
 * 用法：app.js 的 readStorage/writeStorage 委托到 Sync.read/write；
 *       登录/注册走 Sync.login/register；auth 会话存 ln_auth_v1（沿用旧 key）。
 *
 * 事件：bootstrap 成功后派发 `kh:datasync`；降级本地时派发 `kh:syncfallback`。
 */
(function () {
  'use strict';

  const SERVER_KEYS = [
    'ln_forum_posts_v1',
    'ln_community_feed_v1',
    'ln_qa_items_v1',
    'lawyer_cases',
    'lawyer_clients',
    'lawyer_appointments',
    'lawyer_applications',
    'legal_cases',
    'legal_consultations',
    'legal_messages',
    'user_notifications',
    'chat_sessions',
    'chat_messages',
    'user_friends'
  ];
  // users 走专用 API，不通用同步（避免明文密码上送）；但 bootstrap 会拉取安全投影供读取
  const AI_KEY_RE = /^ln_ai_(consult|widget)_history_/;
  const DIRTY_KEY = 'kh_sync_dirty';
  const MTIME_KEY = 'kh_sync_mtime';
  const AUTH_KEY = 'ln_auth_v1';
  const SYNC_DEBOUNCE = 1500;
  // 消息实时轮询：仅拉聊天相关键（比 bootstrap 全量轻量）
  const POLL_KEYS = ['chat_messages', 'chat_sessions', 'user_friends', 'user_notifications'];
  const POLL_INTERVAL = 5000;
  let pollTimer = null;

  function isSyncable(key) {
    return SERVER_KEYS.indexOf(key) !== -1 || AI_KEY_RE.test(key);
  }
  function isServerKey(key) {
    return isSyncable(key) || key === 'users';
  }

  let mode = (function () {
    try { return location.protocol === 'file:' ? 'local' : 'online'; } catch (e) { return 'online'; }
  })();

  const cache = {};
  const dirty = new Set();
  let mtime = {};
  let syncing = false;
  let syncTimer = null;

  // ── 本地存储工具 ─────────────────────────────
  function readRaw(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeRaw(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function loadMeta() {
    mtime = readRaw(MTIME_KEY, {}) || {};
    const d = readRaw(DIRTY_KEY, []);
    if (Array.isArray(d)) d.forEach(k => dirty.add(k));
  }
  function persistMeta() {
    writeRaw(DIRTY_KEY, Array.from(dirty));
    writeRaw(MTIME_KEY, mtime);
  }

  // ── 公开 API ────────────────────────────────
  function read(key, fallback) {
    if (key in cache) return cache[key];
    cache[key] = readRaw(key, fallback);
    return cache[key];
  }

  function write(key, value) {
    cache[key] = value;
    writeRaw(key, value);
    if (isSyncable(key)) markDirty(key);
  }

  function remove(key) {
    delete cache[key];
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    dirty.delete(key);
    persistMeta();
  }

  function clearAll() {
    // 清空全部本地数据 + 同步队列（resetSystem 用）
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    Object.keys(cache).forEach(k => delete cache[k]);
    dirty.clear();
    mtime = {};
    persistMeta();
  }

  function markDirty(key) {
    mtime[key] = Date.now();
    dirty.add(key);
    persistMeta();
    if (mode === 'online') scheduleSync();
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(flush, SYNC_DEBOUNCE);
  }

  function buildPayload() {
    const payload = {};
    dirty.forEach(k => {
      payload[k] = { data: read(k, null), updatedAt: mtime[k] || 0 };
    });
    return { keys: payload };
  }

  function token() {
    try {
      const a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      return (a && a.token) ? a.token : '';
    } catch (e) { return ''; }
  }

  /** 通用 fetch 封装：JSON + 可选 Bearer token + 401 统一处理 */
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.authed !== false) {
      const t = token();
      if (t) headers['Authorization'] = 'Bearer ' + t;
    }
    let resp;
    try {
      resp = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined
      });
    } catch (err) {
      return { ok: false, data: { error: '网络错误：' + err.message }, status: 0 };
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (resp.status === 401) {
      // 会话过期/无效：清登录态
      handle401();
    }
    return { ok: resp.ok, data: data, status: resp.status };
  }

  function handle401() {
    try { localStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
    delete cache[AUTH_KEY];
    dirty.delete(AUTH_KEY);
    try { window.dispatchEvent(new CustomEvent('kh:authchange')); } catch (e) { /* ignore */ }
  }

  // ── 推送脏数据 → 服务器 ──────────────────────
  async function flush() {
    if (syncing) return;
    if (dirty.size === 0 || mode !== 'online') return;
    syncing = true;
    const payload = buildPayload();
    try {
      const res = await api('/api/sync', { method: 'POST', body: payload });
      if (res.ok) {
        dirty.clear();
        persistMeta();
      }
      // 失败则保留 dirty，等下次调度 / 下次加载再推
    } finally {
      syncing = false;
      syncTimer = null;
    }
  }

  // ── bootstrap：先推 dirty → 再拉权威 ─────────
  async function bootstrap() {
    // 1) 先推送离线期间的写入
    if (dirty.size > 0) await flush();

    // 2) 拉权威数据
    const res = await api('/api/bootstrap', { authed: false });
    if (!res.ok || !res.data || !res.data.keys) {
      enterLocalMode();
      return;
    }
    mode = 'online';
    const { keys, serverTime } = res.data;
    let changed = false;
    for (const [k, v] of Object.entries(keys)) {
      if (!isServerKey(k)) continue;
      cache[k] = v;
      writeRaw(k, v);
      if (serverTime) mtime[k] = serverTime;
      changed = true;
    }
    dirty.clear();
    persistMeta();

    // 3) 通知各模块刷新（app.js 监听后 navigate() 重渲当前页）
    try {
      window.dispatchEvent(new CustomEvent('kh:datasync'));
    } catch (e) { /* ignore */ }
    return changed;
  }

  // ── 轻量轮询（消息实时同步）────────────────────
  function startPolling() {
    if (mode !== 'online' || pollTimer) return;
    pollTimer = setInterval(poll, POLL_INTERVAL);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (mode !== 'online' || document.hidden) return;       // 离线/后台标签页跳过
    if (!location.hash.startsWith('#/messages')) return;    // 只在交流中心页轮询
    const res = await api('/api/poll?keys=' + POLL_KEYS.join(','), { authed: false });
    if (!res.ok || !res.data || !res.data.keys) return;
    let changed = false;
    for (const [k, v] of Object.entries(res.data.keys)) {
      if (!isServerKey(k)) continue;
      if (dirty.has(k)) continue;                    // 本端有未推送写入，不覆盖（防丢新写）
      const serverAt = Number(v.updatedAt) || 0;
      if (serverAt >= (mtime[k] || 0)) {             // LWW：服务端不旧于本地才覆盖
        cache[k] = v.data;
        writeRaw(k, v.data);
        mtime[k] = serverAt;
        changed = true;
      }
    }
    if (changed) {
      try { window.dispatchEvent(new CustomEvent('kh:datasync')); } catch (e) { /* ignore */ }
    }
  }

  function enterLocalMode() {
    mode = 'local';
    // 服务器不可达：降级纯本地。通知 app.js 补播被跳过的服务端键
    try { window.dispatchEvent(new CustomEvent('kh:syncfallback')); } catch (e) { /* ignore */ }
  }

  // ── 认证 ────────────────────────────────────
  function setSession(user) {
    if (!user) { remove(AUTH_KEY); return; }
    const existing = read(AUTH_KEY, null) || {};
    // 保留旧 token（调用方可能只传 user 对象）
    const merged = Object.assign({}, user, { token: (user.token || existing.token || '') });
    cache[AUTH_KEY] = merged;
    writeRaw(AUTH_KEY, merged);
  }
  function getAuth() { return read(AUTH_KEY, null); }

  async function login(username, password) {
    const res = await api('/api/auth/login', { method: 'POST', authed: false, body: { username, password } });
    if (res.ok && res.data) {
      setSession(res.data.user ? Object.assign({}, res.data.user, { token: res.data.token }) : null);
      return { ok: true, user: res.data.user };
    }
    return { ok: false, error: (res.data && res.data.error) || '登录失败' };
  }

  async function register(data) {
    const res = await api('/api/auth/register', { method: 'POST', authed: false, body: data });
    if (res.ok && res.data) {
      if (!res.data.pending) setSession(res.data.user ? Object.assign({}, res.data.user, { token: res.data.token }) : null);
      return { ok: true, user: res.data.user, pending: !!res.data.pending };
    }
    return { ok: false, error: (res.data && res.data.error) || '注册失败' };
  }

  async function logout() {
    const t = token();
    if (t) {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    }
    remove(AUTH_KEY);
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    if (res.ok) return { ok: true };
    return { ok: false, error: (res.data && res.data.error) || '修改失败' };
  }

  /** 手动刷新当前用户数据（用户管理/审批后调用，让 bootstrap 之后的缓存保持新鲜） */
  async function refreshUsers() {
    const res = await api('/api/bootstrap', { authed: false });
    if (res.ok && res.data && res.data.keys && res.data.keys.users) {
      cache.users = res.data.keys.users;
      writeRaw('users', res.data.keys.users);
      return res.data.keys.users;
    }
    return null;
  }

  // ── 初始化 ──────────────────────────────────
  function init() {
    loadMeta();
    if (mode === 'online') {
      bootstrap();
      startPolling();
    }
  }

  // 页面关闭前尽力推送（不阻塞、不清 dirty——下次加载会再推）
  try {
    window.addEventListener('beforeunload', () => {
      if (mode === 'online' && dirty.size > 0) {
        try {
          const payload = buildPayload();
          navigator.sendBeacon('/api/sync', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        } catch (e) { /* ignore */ }
      }
    });
  } catch (e) { /* ignore */ }

  window.Sync = {
    // 数据
    read: read,
    write: write,
    remove: remove,
    clearAll: clearAll,
    // 状态
    mode: mode,
    localMode: () => mode === 'local',
    isServerKey: isServerKey,
    // 通用请求（admin 用户管理 / 律师审批等专用 API 用，自动带 token）
    request: api,
    // 认证
    getAuth: getAuth,
    setSession: setSession,
    token: token,
    login: login,
    register: register,
    logout: logout,
    changePassword: changePassword,
    // 维护
    refreshUsers: refreshUsers,
    bootstrap: bootstrap,
    // 消息实时轮询
    startPolling: startPolling,
    stopPolling: stopPolling
  };

  init();
})();
