/**
 * /api/auth/* —— 登录 / 注册 / 退出 / 改密
 */
const express = require('express');
const crypto = require('crypto');
const { hashPassword, verifyPassword, createToken, revokeToken, revokeAllSessions, authMiddleware, safeUser } = require('../auth');

module.exports = function (db) {
  const router = express.Router();

  // POST /api/auth/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = createToken(db, u.id);
    res.json({ user: safeUser(u), token });
  });

  // POST /api/auth/register
  router.post('/register', (req, res) => {
    const { username, password, email, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    if (String(username).length < 3) return res.status(400).json({ error: '用户名至少 3 个字符' });
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 个字符' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    const isLawyer = role === 'lawyer';
    const id = 'id_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const userRole = isLawyer ? 'lawyer_pending' : 'user';
    const status = isLawyer ? 'pending' : 'active';

    db.prepare(
      'INSERT INTO users (id, username, password_hash, email, role, status, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, username, hashPassword(password), email || '', userRole, status, '{}', now, now);

    // 律师注册 → 写入审核申请（kv_rows.lawyer_applications）
    if (isLawyer) {
      const applications = (() => {
        const row = db.prepare('SELECT data FROM kv_rows WHERE key = ?').get('lawyer_applications');
        return row ? JSON.parse(row.data) : [];
      })();
      applications.push({
        id: 'id_' + crypto.randomBytes(8).toString('hex'),
        userId: id,
        username,
        email: email || '',
        status: 'pending',
        appliedAt: now,
        reviewedAt: null,
        reviewedBy: null
      });
      db.prepare(
        'INSERT INTO kv_rows (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).run('lawyer_applications', JSON.stringify(applications), now);
    }

    const token = createToken(db, id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.status(201).json({ user: safeUser(fresh), token, pending: isLawyer });
  });

  // POST /api/auth/logout（optional-auth：有 token 就吊销）
  router.post('/logout', authMiddleware(db, {}), (req, res) => {
    if (req.token) revokeToken(db, req.token);
    res.json({ ok: true });
  });

  // POST /api/auth/change-password（本人，需验证当前密码）
  router.post('/change-password', authMiddleware(db, { required: true }), (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const u = req.user;
    if (!u) return res.status(401).json({ error: '未登录或会话已过期' });
    if (!verifyPassword(currentPassword || '', u.password_hash)) {
      return res.status(400).json({ error: '当前密码不正确' });
    }
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ error: '新密码至少 6 个字符' });
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(newPassword), Date.now(), u.id
    );
    // 吊销该用户全部 session（含当前）
    revokeAllSessions(db, u.id);
    res.json({ ok: true, error: null });
  });

  return router;
};
