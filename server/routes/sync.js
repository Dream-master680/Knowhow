/**
 * /api/bootstrap + /api/sync —— 数据同步（optional-auth）
 * ─────────────────────────────────────────────
 * bootstrap：拉取全部托管键数据 + users 安全投影；已登录时附带本账号 ai_history。
 * sync：客户端上送快照，整键 LWW（updated_at 新旧比较）；仅接受 SERVER_KEYS + ai_history 键。
 *
 * sync 请求体格式：{ keys: { [key]: { data: <数组/对象>, updatedAt: <客户端时间戳> } } }
 */
const express = require('express');
const { authMiddleware, safeUser } = require('../auth');
const { SERVER_KEYS, readKv, writeKv } = require('../db');

const AI_KEY_RE = /^ln_ai_(consult|widget)_history_/;

module.exports = function (db) {
  const router = express.Router();

  // GET /api/bootstrap
  router.get('/bootstrap', authMiddleware(db, {}), (req, res) => {
    const keys = {};
    for (const k of SERVER_KEYS) {
      const row = db.prepare('SELECT data FROM kv_rows WHERE key = ?').get(k);
      if (row) keys[k] = JSON.parse(row.data);
    }
    // users：服务端权威，安全投影（无密码）
    keys.users = db.prepare('SELECT * FROM users').all().map(safeUser);

    // ai_history：仅已登录用户，按 kind 聚合
    const ai = {};
    if (req.user) {
      for (const kind of ['consult', 'widget']) {
        const row = db.prepare('SELECT data FROM ai_history WHERE user_id = ? AND kind = ?').get(req.user.id, kind);
        if (row) ai[kind] = JSON.parse(row.data);
      }
    }
    res.json({ keys, ai, serverTime: Date.now() });
  });

  // POST /api/sync
  router.post('/sync', authMiddleware(db, {}), (req, res) => {
    const { keys } = req.body || {};
    if (!keys || typeof keys !== 'object') return res.status(400).json({ error: 'keys 参数非法' });

    let accepted = 0;
    for (const [k, entry] of Object.entries(keys)) {
      const now = Date.now();
      const val = (entry && typeof entry === 'object' && 'data' in entry) ? entry.data : entry;
      const clientAt = (entry && typeof entry === 'object' && entry.updatedAt) ? Number(entry.updatedAt) : 0;

      // 1) ai_history 键：仅登录用户可写；kind 从键名解析
      const aiMatch = k.match(AI_KEY_RE);
      if (aiMatch) {
        if (!req.user) continue; // 游客的 AI 历史留本地
        const kind = aiMatch[1];
        db.prepare(
          'INSERT INTO ai_history (user_id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
        ).run(req.user.id, kind, JSON.stringify(val), now);
        accepted++;
        continue;
      }

      // 2) users：专用键，不通用同步（丢弃 password，避免明文进库）
      if (k === 'users') {
        if (!Array.isArray(val)) continue;
        const updateUser = db.prepare('UPDATE users SET email = ?, profile = ?, updated_at = ? WHERE id = ?');
        for (const u of val) {
          if (!u || !u.id) continue;
          if (!db.prepare('SELECT id FROM users WHERE id = ?').get(u.id)) continue;
          let profile = '{}';
          try { profile = JSON.stringify(u.profile || {}); } catch (e) { profile = '{}'; }
          updateUser.run(u.email || '', profile, now, u.id);
        }
        accepted++;
        continue;
      }

      // 3) 其余仅接受托管键
      if (!SERVER_KEYS.includes(k)) continue;

      // 整键 LWW：客户端 updated_at 旧于服务端则丢弃（防旧数据回滚新数据）
      const row = db.prepare('SELECT updated_at FROM kv_rows WHERE key = ?').get(k);
      if (row && clientAt && clientAt < row.updated_at) continue;
      writeKv(db, k, val, now);
      accepted++;
    }

    res.json({ ok: true, accepted });
  });

  return router;
};
