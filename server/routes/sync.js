/**
 * /api/bootstrap + /api/poll + /api/sync —— 数据同步（optional-auth）
 * ─────────────────────────────────────────────
 * bootstrap：拉取托管键 + users 安全投影 + 本人 ai_history；按登录用户过滤私有键。
 * poll：按当前路由取键，返回 data + updatedAt；同样按用户过滤。
 * sync：客户端上送快照。数组键改为 **item 级合并**（并集 + 新鲜度 + 墓碑），
 *       消除并发整键 LWW 覆盖丢数据；aboutInfo(对象) 保留整键 LWW。
 *       写入按登录用户分层鉴权：游客只能 seed 空公开键；私有键按归属过滤。
 *
 * sync 请求体格式：{ keys: { [key]: { data: <数组/对象>, updatedAt: <客户端时间戳> } } }
 * 响应：{ ok, accepted, rejected } —— rejected 为未接受的键名数组（前端保留 dirty 重推）。
 */
const express = require('express');
const { authMiddleware, safeUser } = require('../auth');
const {
  SERVER_KEYS, readKv, writeKv, getUpdatedAt, isAdmin,
  mergeArrays, stripDeleted, readOwner, writeOwner, isPrivateKey
} = require('../db');

const AI_KEY_RE = /^ln_ai_(consult|widget)_history_/;

module.exports = function (db) {
  const router = express.Router();

  // GET /api/bootstrap
  router.get('/bootstrap', authMiddleware(db, {}), (req, res) => {
    const keys = {};
    for (const k of SERVER_KEYS) {
      const row = db.prepare('SELECT data FROM kv_rows WHERE key = ?').get(k);
      if (!row) continue;
      const data = JSON.parse(row.data);
      if (isPrivateKey(k)) {
        // 私有键按登录用户裁剪（游客 → 空）
        const filter = readOwner(db, k, req.user);
        keys[k] = Array.isArray(data) ? stripDeleted(data.filter(filter)) : data;
      } else {
        keys[k] = stripDeleted(data);
      }
    }
    // users：仅登录用户返回全量安全投影（消息/好友选择接收人需要）；游客给空
    keys.users = req.user ? db.prepare('SELECT * FROM users').all().map(safeUser) : [];

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

  // GET /api/poll?keys=a,b,c —— 轻量轮询：只返回指定托管键 + 每键 updatedAt
  router.get('/poll', authMiddleware(db, {}), (req, res) => {
    const requested = String(req.query.keys || '').split(',').filter(Boolean);
    const keys = {};
    for (const k of requested) {
      if (!SERVER_KEYS.includes(k)) continue;
      const row = db.prepare('SELECT data, updated_at FROM kv_rows WHERE key = ?').get(k);
      if (!row) continue;
      let data = JSON.parse(row.data);
      if (isPrivateKey(k)) {
        const filter = readOwner(db, k, req.user);
        data = Array.isArray(data) ? data.filter(filter) : data;
      }
      keys[k] = { data: stripDeleted(data), updatedAt: row.updated_at };
    }
    res.json({ keys, serverTime: Date.now() });
  });

  // POST /api/sync
  router.post('/sync', authMiddleware(db, {}), (req, res) => {
    const { keys } = req.body || {};
    if (!keys || typeof keys !== 'object') return res.status(400).json({ error: 'keys 参数非法' });

    let accepted = 0;
    const rejected = [];
    for (const [k, entry] of Object.entries(keys)) {
      const now = Date.now();
      let val = (entry && typeof entry === 'object' && 'data' in entry) ? entry.data : entry;
      const clientAt = (entry && typeof entry === 'object' && entry.updatedAt) ? Number(entry.updatedAt) : 0;

      // 1) ai_history 键：仅登录用户可写；kind 从键名解析
      const aiMatch = k.match(AI_KEY_RE);
      if (aiMatch) {
        if (!req.user) { rejected.push(k); continue; }
        const kind = aiMatch[1];
        db.prepare(
          'INSERT INTO ai_history (user_id, kind, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
        ).run(req.user.id, kind, JSON.stringify(val), now);
        accepted++;
        continue;
      }

      // 2) users：专用键，仅 admin（防任意调用方篡改他人 email/profile）
      if (k === 'users') {
        if (!req.user || !isAdmin(req.user) || !Array.isArray(val)) { rejected.push(k); continue; }
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
      if (!SERVER_KEYS.includes(k)) { rejected.push(k); continue; }

      // 4) 鉴权分层
      if (!req.user) {
        // 游客：私有键一律拒；公开键仅当服务端该键为空时放行（空服务器首访补播 seed），有内容则拒（防污染）
        if (isPrivateKey(k)) { rejected.push(k); continue; }
        const cur = readKv(db, k);
        const hasContent = Array.isArray(cur) ? cur.length > 0 : cur !== undefined;
        if (hasContent) { rejected.push(k); continue; }
      } else {
        // 已登录：lawyer_applications 仅 admin；私有键按归属过滤（防注入/篡改）
        if (k === 'lawyer_applications' && !isAdmin(req.user)) { rejected.push(k); continue; }
        if (isPrivateKey(k)) {
          const filter = writeOwner(db, k, req.user);
          val = Array.isArray(val) ? val.filter(filter) : [];
        }
      }

      // 5) 合并写：aboutInfo(对象) 整键 LWW；数组键 item 级合并
      if (typeof val !== 'object' || val === null) { rejected.push(k); continue; }
      if (k === 'aboutInfo' || !Array.isArray(val)) {
        const srvAt = getUpdatedAt(db, k);
        if (srvAt != null && clientAt && clientAt < srvAt) { rejected.push(k); continue; }
        writeKv(db, k, val, now);
        accepted++;
        continue;
      }
      const merged = mergeArrays(readKv(db, k), val);
      writeKv(db, k, merged, now);
      accepted++;
    }

    res.json({ ok: true, accepted, rejected });
  });

  return router;
};
