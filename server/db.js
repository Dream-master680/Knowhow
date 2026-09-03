/**
 * KnowHow SQLite 数据库模块
 * ─────────────────────────────────────────────
 * better-sqlite3 + WAL 模式；建表 + 首启种子。
 * 内容型数据用 kv_rows 行式 JSON 存储（key 与前端 localStorage key 一致）。
 */
const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword } = require('./auth');
const SEED = require('./seed-data');

/** 服务端托管键（进 kv_rows，与前端 Sync.SERVER_KEYS 保持一致） */
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
  // 展示内容（前端 app.js 播种，首个访客 bootstrap 后补播自举上送）
  'ln_news_v1',
  'ln_films_v1',
  'ln_law_updates_v1',
  'ln_lawyers_v1',
  'aboutInfo'
];

function initDb() {
  const dbPath = path.join(__dirname, 'data.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email         TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user',
      status        TEXT NOT NULL DEFAULT 'active',
      profile       TEXT NOT NULL DEFAULT '{}',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS kv_rows (
      key        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_history (
      user_id    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
  `);

  seedIfEmpty(db);
  return db;
}

/** 首启种子：内置账号 + 论坛/社区/问答内容 */
function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (id, username, password_hash, email, role, status, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const u of SEED.users) {
    insertUser.run(u.id, u.username, hashPassword(u.password), u.email || '', u.role, u.status || 'active', '{}', u.createdAt || Date.now(), u.createdAt || Date.now());
  }

  const insertKv = db.prepare('INSERT INTO kv_rows (key, data, updated_at) VALUES (?, ?, ?)');
  for (const [k, arr] of Object.entries(SEED.kvRows)) {
    insertKv.run(k, JSON.stringify(arr), Date.now());
  }
}

/** 读取某个托管键的 JSON（无则返回 undefined） */
function readKv(db, key) {
  const row = db.prepare('SELECT data FROM kv_rows WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : undefined;
}

/** 写入某个托管键的 JSON */
function writeKv(db, key, data, updatedAt) {
  db.prepare(
    'INSERT INTO kv_rows (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).run(key, JSON.stringify(data), updatedAt == null ? Date.now() : updatedAt);
}

/** 读取某键的 updated_at（无则 undefined；整键 LWW 判断用） */
function getUpdatedAt(db, key) {
  const row = db.prepare('SELECT updated_at FROM kv_rows WHERE key = ?').get(key);
  return row ? row.updated_at : undefined;
}

/** 管理员角色 */
const ADMIN_ROLES = ['superadmin', 'admin'];
function isAdmin(user) {
  return !!user && ADMIN_ROLES.includes(user.role);
}

/** item 新鲜度：updatedAt || createdAt || appliedAt || lastReadAt || 0（多数 item 无 updatedAt，用 createdAt 兜底） */
function itemAt(it) {
  if (!it || typeof it !== 'object') return 0;
  return Number(it.updatedAt) || Number(it.createdAt) || Number(it.appliedAt) || Number(it.lastReadAt) || 0;
}

/**
 * 数组键合并（整键 LWW → item 级合并，消除并发整键覆盖丢数据）：
 *  - 按 id 去重并集；无 id 的 item 按 JSON 串兜底 key
 *  - 同一 id：itemAt 新者胜；墓碑(_deleted)新者胜；两者都活体且时间平局 → client 胜（本端当前视图为准）
 * 返回合并后的数组（含墓碑；响应下发时由 stripDeleted 剥离）
 */
function mergeArrays(cur, client) {
  const map = new Map();
  const keyOf = (it) => (it && it.id != null) ? 'id:' + it.id : 'raw:' + JSON.stringify(it);
  for (const it of (Array.isArray(cur) ? cur : [])) {
    if (it == null) continue;
    map.set(keyOf(it), it);
  }
  for (const it of (Array.isArray(client) ? client : [])) {
    if (it == null) continue;
    const k = keyOf(it);
    const existing = map.get(k);
    if (!existing) { map.set(k, it); continue; }
    const a = itemAt(it);
    const b = itemAt(existing);
    const itDel = it._deleted === true;
    const exDel = existing._deleted === true;
    if (itDel || exDel) {
      // 墓碑 vs 活体：新者胜；时间平局时墓碑胜（删除应可靠）；双墓碑取新
      map.set(k, (a >= b ? it : existing));
      continue;
    }
    map.set(k, a >= b ? it : existing);
  }
  return Array.from(map.values());
}

/** 从数组中剥离墓碑（仅响应下发用，存储与客户端 raw 保留墓碑） */
function stripDeleted(arr) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((it) => !(it && it._deleted === true));
}

/**
 * 读过滤：bootstrap/poll 按登录用户裁剪私有键。
 * 返回 (item)=>boolean 过滤函数；游客→私有键全 false；admin→全 true；公开键→恒 true。
 */
function readOwner(db, key, user) {
  if (!user) {
    // 游客：仅公开键可见（首页公共预览），私有键不可见
    return () => !isPrivateKey(key);
  }
  if (isAdmin(user)) return () => true;
  const uid = user.id;
  switch (key) {
    case 'chat_sessions':
      return (it) => it.userId1 === uid || it.userId2 === uid;
    case 'chat_messages': {
      // 会话双方都可见：我是发送者，或消息所在会话我参与
      const mySessions = new Set(
        (readKv(db, 'chat_sessions') || [])
          .filter((s) => s.userId1 === uid || s.userId2 === uid)
          .map((s) => s.id)
      );
      return (it) => it.senderId === uid || mySessions.has(it.sessionId);
    }
    case 'legal_messages':
      return (it) => it.fromUserId === uid || it.toUserId === uid;
    case 'legal_consultations':
      // 咨询：本人发布 + 本人接单；另律师角色可见「待回复(pending)」业务池 —— 与前端 renderInteraction
      // 律师视图过滤(status==='pending'||lawyerId===me)对齐，否则陌生人新咨询永远不下发律师
      return (it) => it.userId === uid || it.lawyerId === uid || (user.role === 'lawyer' && it.status === 'pending');
    case 'legal_cases':
      // 案件：本人发布 + 本人接单；另律师角色可见「待接单(open)」业务池 —— 与前端律师视图过滤对齐
      return (it) => it.userId === uid || it.lawyerId === uid || (user.role === 'lawyer' && it.status === 'open');
    case 'user_notifications':
      return (it) => it.toUserId === uid || it.userId === uid;
    case 'user_friends':
      return (it) => it.userId === uid || it.lawyerId === uid;
    case 'lawyer_cases':
    case 'lawyer_clients':
    case 'lawyer_appointments':
      return (it) => it.lawyerId === uid;
    case 'lawyer_applications':
      return () => false; // 仅 admin 可见（isAdmin 已在上方放行）
    default:
      return () => true; // 公开键
  }
}

/**
 * 写过滤：/api/sync 按登录用户裁剪传入快照（防注入/篡改他人数据）。
 * admin 全量；游客私有键全 false（sync.js 另有「公开键空键 seed」放行）。
 */
function writeOwner(db, key, user) {
  if (!user) return () => false;
  if (isAdmin(user)) return () => true;
  const uid = user.id;
  switch (key) {
    case 'chat_sessions':
      return (it) => it.userId1 === uid || it.userId2 === uid;
    case 'chat_messages':
      return (it) => it.senderId === uid; // 只能写自己发的消息
    case 'legal_messages':
      return (it) => it.fromUserId === uid || it.toUserId === uid;
    case 'legal_consultations':
    case 'legal_cases':
      return (it) => it.userId === uid || it.lawyerId === uid;
    case 'user_notifications':
      // 收件人(toUserId/userId)可写（标记已读）；创建者常是发送方(fromUserId)也要能写
      return (it) => it.toUserId === uid || it.userId === uid || it.fromUserId === uid;
    case 'user_friends':
      return (it) => it.userId === uid || it.lawyerId === uid;
    case 'lawyer_cases':
    case 'lawyer_clients':
    case 'lawyer_appointments':
      return (it) => it.lawyerId === uid;
    case 'lawyer_applications':
      return () => false; // 仅 admin（在线注册走服务端，客户端不写该键）
    default:
      return () => true; // 公开键：登录用户可写
  }
}

/** 私有键集合（游客不可见/不可写；其余为公开键） */
const PRIVATE_KEYS = new Set([
  'chat_sessions', 'chat_messages',
  'legal_messages', 'legal_consultations', 'legal_cases',
  'user_notifications', 'user_friends',
  'lawyer_cases', 'lawyer_clients', 'lawyer_appointments',
  'lawyer_applications'
]);
function isPrivateKey(key) {
  return PRIVATE_KEYS.has(key);
}

module.exports = {
  initDb, seedIfEmpty, SERVER_KEYS, readKv, writeKv,
  getUpdatedAt, isAdmin, mergeArrays, stripDeleted, readOwner, writeOwner, isPrivateKey
};
