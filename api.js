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
    'user_friends',
    // 展示内容（app.js 播种，空服务器由首个访客 bootstrap 后补播自举上送）
    'ln_news_v1',
    'ln_films_v1',
    'ln_law_updates_v1',
    'ln_lawyers_v1',
    'aboutInfo'
  ];
  // users 走专用 API，不通用同步（避免明文密码上送）；但 bootstrap 会拉取安全投影供读取
  const AI_KEY_RE = /^ln_ai_(consult|widget)_history_/;
  const DIRTY_KEY = 'kh_sync_dirty';
  const MTIME_KEY = 'kh_sync_mtime';
  const AUTH_KEY = 'ln_auth_v1';
  const SYNC_DEBOUNCE = 1500;
  // 实时轮询：按「当前路由 → 依赖键集」映射，各页只轮询自己关心的键。
  // 展示内容页只刷内容键——聊天/通知变更不会触发它们重渲（保住输入框焦点/轮播）；
  // 纯本地页（profile/settings/civilcode/login 等）routePollKeys 返回 null → 不轮询。
  const POLL_INTERVAL = 5000;
  const POLL_ROUTES = {
    home: ['ln_news_v1', 'ln_films_v1', 'ln_law_updates_v1', 'ln_lawyers_v1', 'aboutInfo', 'ln_forum_posts_v1', 'ln_community_feed_v1', 'ln_qa_items_v1'],
    news: ['ln_news_v1'],
    films: ['ln_films_v1'],
    lawUpdates: ['ln_law_updates_v1'],
    about: ['aboutInfo'],
    lawyers: ['ln_lawyers_v1'],
    forum: ['ln_forum_posts_v1', 'ln_community_feed_v1', 'ln_qa_items_v1'],
    messages: ['chat_messages', 'chat_sessions', 'user_friends', 'user_notifications'],
    interaction: ['legal_messages', 'legal_consultations', 'legal_cases'],
    admin: SERVER_KEYS.slice()
  };
  function routePollKeys() {
    const h = location.hash;
    if (h.startsWith('#/messages')) return POLL_ROUTES.messages;
    if (h.startsWith('#/interaction')) return POLL_ROUTES.interaction;
    if (h.startsWith('#/admin')) return POLL_ROUTES.admin;
    if (h.startsWith('#/news')) return POLL_ROUTES.news;
    if (h.startsWith('#/films')) return POLL_ROUTES.films;
    if (h.startsWith('#/law-updates')) return POLL_ROUTES.lawUpdates;
    if (h.startsWith('#/about')) return POLL_ROUTES.about;
    if (h.startsWith('#/lawyers')) return POLL_ROUTES.lawyers;
    if (h.startsWith('#/forum')) return POLL_ROUTES.forum;
    if (h === '' || h === '#' || h.startsWith('#/')) return POLL_ROUTES.home; // 首页/未匹配兜底
    return null; // 纯本地页不轮询
  }
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

  // 内容级比较：仅当服务端键数据真的变了才值得触发整页重渲
  function dataEqual(a, b) {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
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
    if (key in cache) {
      const v = cache[key];
      // 缓存/存储值为 null 或 undefined、但本次调用提供了默认值时：返回默认值，
      // 避免「先用 null fallback 读取过 → 缓存被 null 污染 → 后续带默认值读取仍拿到 null」导致的渲染崩溃
      return (v == null && fallback !== undefined) ? fallback : v;
    }
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
    // 会话失效 → 清登录态后以游客身份重拉（不降级本地模式，私有数据随游客返回置空）
    scheduleReload();
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
        // 只清「被接受」的键；被拒的保留 dirty（如游客写入私有键被拒 → 登录后重推，不丢数据）
        const rejected = (res.data && Array.isArray(res.data.rejected)) ? res.data.rejected : [];
        if (rejected.length > 0) {
          const rej = new Set(rejected);
          [...dirty].forEach(k => { if (!rej.has(k)) dirty.delete(k); });
        } else {
          dirty.clear();
        }
        persistMeta();
      }
      // 失败则保留 dirty，等下次调度 / 下次加载再推
    } finally {
      syncing = false;
      syncTimer = null;
    }
  }

  // ── bootstrap：先推 dirty → 再拉权威 ─────────
  let bootstrapping = false;
  async function bootstrap() {
    if (bootstrapping) return false;
    bootstrapping = true;
    try {
      // 1) 先推送离线期间的写入（登录后带 token；被拒的键保留 dirty 等重推）
      if (dirty.size > 0) await flush();

      // 2) 拉权威数据（带 token：登录后服务端按用户过滤私有键）
      const res = await api('/api/bootstrap');
      if (res.status === 401) {
        // token 失效：api() 已清登录态，scheduleReload 稍后以游客身份重拉（不降级本地模式）
        return false;
      }
      if (!res.ok || !res.data || !res.data.keys) {
        enterLocalMode();
        return false;
      }
      mode = 'online';
      const { keys, serverTime } = res.data;
      let changed = false;
      for (const [k, v] of Object.entries(keys)) {
        if (!isServerKey(k)) continue;
        if (dirty.has(k)) continue;      // 本端有未上送写入：保留本地，等下次重推（flush 拒了它）
        cache[k] = v;
        writeRaw(k, v);
        if (serverTime) mtime[k] = serverTime;
        changed = true;
      }
      // 不整体 dirty.clear()：flush 成功后已清「被接受」键；剩余为被拒键 → 保留，登录后重推
      persistMeta();

      // 3) 通知各模块刷新（app.js 监听后 navigate() 重渲当前页）
      try {
        window.dispatchEvent(new CustomEvent('kh:datasync'));
      } catch (e) { /* ignore */ }
      return changed;
    } finally {
      bootstrapping = false;
    }
  }

  // ── 登录态变化后重新拉取（防并发/防递归：事件里延迟到当前请求结束再拉）──
  let reloadQueued = false;
  function scheduleReload() {
    if (reloadQueued) return;
    reloadQueued = true;
    setTimeout(function () {
      reloadQueued = false;
      if (mode !== 'online') return;
      bootstrap();
    }, 0);
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
    // 按当前路由取关心的键集：展示页只刷内容键，纯本地页 null 不轮询
    const keys = routePollKeys();
    if (!keys || keys.length === 0) return;
    const res = await api('/api/poll?keys=' + keys.join(','));
    if (!res.ok || !res.data || !res.data.keys) return;
    let changed = false;
    for (const [k, v] of Object.entries(res.data.keys)) {
      if (!isServerKey(k)) continue;
      if (dirty.has(k)) continue;                    // 本端有未推送写入，不覆盖（防丢新写）
      const serverAt = Number(v.updatedAt) || 0;
      if (serverAt < (mtime[k] || 0)) continue;      // LWW：服务端不旧于本地才覆盖
      // 内容级守卫：时间戳相等≠内容变了（比如刚上线的并发写入、或自家写入的回声）。
      // 旧代码 `>=` 把「时间戳相等」也判成变了 → 每次 poll 都 changed → 每 5s 整页重渲，
      // 输入框被重建 = 闪跳/丢字/丢焦点（线上多人写入时尤其明显：本地单测不触发）。
      const prev = cache[k];
      const next = v.data;
      if (dataEqual(prev, next)) {
        if (serverAt > (mtime[k] || 0)) mtime[k] = serverAt;   // 内容没变：只对齐时间，不重渲
        continue;
      }
      cache[k] = next;
      writeRaw(k, next);
      mtime[k] = serverAt;
      changed = true;
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
      scheduleReload();   // 登录后按当前用户重拉（私有数据 + users）
      return { ok: true, user: res.data.user };
    }
    return { ok: false, error: (res.data && res.data.error) || '登录失败' };
  }

  async function register(data) {
    const res = await api('/api/auth/register', { method: 'POST', authed: false, body: data });
    if (res.ok && res.data) {
      if (!res.data.pending) {
        setSession(res.data.user ? Object.assign({}, res.data.user, { token: res.data.token }) : null);
        scheduleReload();
      }
      return { ok: true, user: res.data.user, pending: !!res.data.pending };
    }
    return { ok: false, error: (res.data && res.data.error) || '注册失败' };
  }

  async function logout() {
    // 登出前先把未上送写入推出去（带当前 token，避免登出后游客身份被拒）
    if (mode === 'online' && dirty.size > 0) {
      try { await flush(); } catch (e) { /* ignore */ }
    }
    const t = token();
    if (t) {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    }
    remove(AUTH_KEY);
    scheduleReload();   // 以游客身份重拉：清本地私有数据 + users
  }

  async function changePassword(currentPassword, newPassword) {
    const res = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
    if (res.ok) return { ok: true };
    return { ok: false, error: (res.data && res.data.error) || '修改失败' };
  }

  /** 手动刷新当前用户数据（用户管理/审批后调用，让 bootstrap 之后的缓存保持新鲜） */
  async function refreshUsers() {
    const res = await api('/api/bootstrap');
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
    // 数据（公开 read 剥离墓碑：渲染层永远看不到 _deleted item；flush 走内部 raw read，墓碑照常上送）
    read: function (key, fallback) {
      const v = read(key, fallback);
      return Array.isArray(v) ? v.filter(function (it) { return !(it && it._deleted === true); }) : v;
    },
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
