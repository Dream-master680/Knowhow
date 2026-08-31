/**
 * /api/users/* —— 用户管理（admin 专用）
 * ─────────────────────────────────────────────
 * 增删改 / 角色切换 / 密码重置 / 律师申请审批。
 * 规则照搬前端 app.js：
 *  · superadmin（admin 账号）不可降级
 *  · 律师申请审批同时更新对应用户 role / status
 *  · 重置密码后吊销该用户全部 session
 */
const express = require('express');
const crypto = require('crypto');
const { hashPassword, revokeAllSessions, authMiddleware, adminOnly, safeUser } = require('../auth');
const { readKv, writeKv } = require('../db');

module.exports = function (db) {
  const router = express.Router();
  router.use(authMiddleware(db, { required: true }), adminOnly);

  function getById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  // POST /api/users —— 管理员新增用户
  router.post('/', (req, res) => {
    const { username, password, email, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 个字符' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const isLawyer = role === 'lawyer';
    const id = 'id_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    db.prepare(
      'INSERT INTO users (id, username, password_hash, email, role, status, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, username, hashPassword(password), email || '', isLawyer ? 'lawyer' : (role || 'user'), 'active', '{}', now, now);
    res.status(201).json({ user: safeUser(getById(id)) });
  });

  // PUT /api/users/:id —— 更新 email / role / status / profile（不含密码）
  router.put('/:id', (req, res) => {
    const u = getById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const { email, role, status, profile } = req.body || {};
    const targetRole = role || u.role;

    // 角色保护：admin 账号必须保持 superadmin；不可把他人提为 superadmin
    if (u.username === 'admin') {
      if (targetRole !== 'superadmin') return res.status(400).json({ error: 'admin 账号必须是超级管理员' });
      if (req.user.id !== u.id) return res.status(403).json({ error: '超级管理员账号仅本人可修改' });
    } else if (targetRole === 'superadmin') {
      return res.status(403).json({ error: '不能设置超级管理员' });
    }

    let profileJson = '{}';
    try { profileJson = JSON.stringify(profile || {}); } catch (e) { profileJson = '{}'; }
    db.prepare('UPDATE users SET email = ?, role = ?, status = ?, profile = ?, updated_at = ? WHERE id = ?')
      .run(email != null ? email : u.email, targetRole, status || u.status, profileJson, Date.now(), u.id);
    res.json({ user: safeUser(getById(u.id)) });
  });

  // DELETE /api/users/:id —— 删除用户
  router.delete('/:id', (req, res) => {
    const u = getById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    if (u.username === 'admin') return res.status(400).json({ error: '不能删除超级管理员' });
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    res.json({ ok: true });
  });

  // POST /api/users/:id/role —— 切换角色
  router.post('/:id/role', (req, res) => {
    const u = getById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ error: '缺少角色' });
    if (u.username === 'admin' && role !== 'superadmin') {
      return res.status(400).json({ error: 'admin 账号必须是超级管理员' });
    }
    if (role === 'superadmin' && u.username !== 'admin') {
      return res.status(403).json({ error: '不能设置超级管理员' });
    }
    db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(role, role === 'lawyer_pending' ? 'pending' : 'active', Date.now(), u.id);
    res.json({ user: safeUser(getById(u.id)) });
  });

  // POST /api/users/:id/password —— 管理员重置密码（吊销该用户全部 session）
  router.post('/:id/password', (req, res) => {
    const u = getById(req.params.id);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: '密码至少 6 个字符' });
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), Date.now(), u.id);
    revokeAllSessions(db, u.id);
    res.json({ ok: true });
  });

  // POST /api/users/:id/profile —— 本人保存资料
  router.post('/:id/profile', (req, res) => {
    if (req.user.id !== req.params.id) return res.status(403).json({ error: '只能修改自己的资料' });
    const { profile, email } = req.body || {};
    let profileJson = '{}';
    try { profileJson = JSON.stringify(profile || {}); } catch (e) { profileJson = '{}'; }
    const u = getById(req.params.id);
    db.prepare('UPDATE users SET profile = ?, email = ?, updated_at = ? WHERE id = ?')
      .run(profileJson, email != null ? email : u.email, Date.now(), u.id);
    res.json({ user: safeUser(getById(u.id)) });
  });

  // POST /api/lawyer-applications/:id/approve | /reject
  const handleLawyerApplication = (approve) => (req, res) => {
    const applications = (() => {
      const row = db.prepare('SELECT data FROM kv_rows WHERE key = ?').get('lawyer_applications');
      return row ? JSON.parse(row.data) : [];
    })();
    const app = applications.find(a => a.id === req.params.id);
    if (!app) return res.status(404).json({ error: '申请不存在' });

    const now = Date.now();
    app.status = approve ? 'approved' : 'rejected';
    app.reviewedAt = now;
    app.reviewedBy = req.user.id;

    const u = getById(app.userId);
    if (u) {
      if (approve) {
        db.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?')
          .run('lawyer', 'active', now, u.id);
      } else {
        db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('rejected', now, u.id);
      }
    }

    // 律师推广卡协同认证：通过 → upsert 已认证卡；拒绝 → 卡 verified=false（保留其余字段，管理员可补全资料）
    const rawLawyers = readKv(db, 'ln_lawyers_v1');
    const lawyers = Array.isArray(rawLawyers) ? rawLawyers : [];
    let lawyerCard = null;
    const idx = lawyers.findIndex(l => l && l.username === app.username);
    if (idx !== -1) {
      lawyerCard = lawyers[idx];
      if (approve) {
        lawyerCard.verified = true;
        if (!lawyerCard.email && app.email) lawyerCard.email = app.email;
        lawyerCard.updatedAt = now;
      } else {
        lawyerCard.verified = false;
        lawyerCard.updatedAt = now;
      }
    } else if (approve) {
      lawyerCard = {
        id: 'id_' + crypto.randomBytes(8).toString('hex'),
        username: app.username,
        name: app.username,
        email: app.email || '',
        firm: '',
        areas: [],
        bio: '',
        verified: true,
        createdAt: now,
        updatedAt: now
      };
      lawyers.push(lawyerCard);
    }
    if (lawyerCard) writeKv(db, 'ln_lawyers_v1', lawyers, now);

    db.prepare(
      'INSERT INTO kv_rows (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
    ).run('lawyer_applications', JSON.stringify(applications), now);
    res.json({ ok: true, application: app, lawyerCard: lawyerCard || null });
  };
  router.post('/lawyer-applications/:id/approve', handleLawyerApplication(true));
  router.post('/lawyer-applications/:id/reject', handleLawyerApplication(false));

  return router;
};
