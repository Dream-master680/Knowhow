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
  'user_friends'
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

module.exports = { initDb, seedIfEmpty, SERVER_KEYS, readKv, writeKv };
