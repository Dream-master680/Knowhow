/**
 * KnowHow 后端认证模块
 * ─────────────────────────────────────────────
 * · scrypt 密码哈希（Node 内置 crypto，零原生依赖）
 * · 会话 token 生成 / 校验 / 吊销
 * · 认证中间件（支持 optional / required 两种模式）
 * · safeUser 安全投影（永不返回密码哈希）
 */
const crypto = require('crypto');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 24 * 3600 * 1000); // 默认 30 天

/** scrypt 哈希：格式 scrypt$<salt hex>$<hash hex> */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password || ''), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const hash = crypto.scryptSync(String(password || ''), Buffer.from(parts[1], 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(parts[2], 'hex'));
  } catch (e) {
    return false;
  }
}

/** 创建会话，返回 token */
function createToken(db, userId, ttlMs = SESSION_TTL_MS) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, now, now + ttlMs);
  return token;
}

/** 吊销单个会话 */
function revokeToken(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 吊销某用户全部会话（改密 / 重置密码后调用） */
function revokeAllSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * 认证中间件
 * @param {object} db
 * @param {object} opts { required: boolean }
 *  - required=false：带 token 且有效则挂 req.user，否则 req.user = null（游客）
 *  - required=true ：无有效 token 直接 401
 */
function authMiddleware(db, opts) {
  opts = opts || {};
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let user = null;
    if (token) {
      const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      if (session && session.expires_at > Date.now()) {
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        req.token = token;
      } else if (session) {
        // 过期会话清理
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
    }
    if (opts.required && !user) {
      return res.status(401).json({ error: '未登录或会话已过期' });
    }
    req.user = user; // 可能为 null（optional 模式）
    next();
  };
}

/** 需要 admin / superadmin 角色的中间件 */
function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/** 用户安全投影：绝不返回 password_hash / salt */
function safeUser(u) {
  if (!u) return null;
  let profile = {};
  try { profile = JSON.parse(u.profile || '{}'); } catch (e) { profile = {}; }
  return {
    id: u.id,
    username: u.username,
    email: u.email || '',
    role: u.role,
    status: u.status,
    profile,
    createdAt: u.created_at,
    updatedAt: u.updated_at
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createToken,
  revokeToken,
  revokeAllSessions,
  authMiddleware,
  adminOnly,
  safeUser
};
