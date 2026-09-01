/**
 * 只读数据库查看工具（本地/服务器通用）
 * ─────────────────────────────────────────────
 * 用法：cd server && node scripts/db-view.js [db路径]
 * 说明：列出表+行数、users 安全投影（不含密码）、kv_rows 各键条目、ai_history。
 * 只读，不会改动任何数据；密码字段一律不查（安全约束）。
 */
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
console.log('=== 表与行数 ===');
for (const t of tables) {
  const n = db.prepare('SELECT COUNT(*) c FROM "' + t.name + '"').get().c;
  console.log('  ' + t.name + '  → ' + n + ' 行');
}

console.log('\n=== users（安全投影，无 password_hash）===');
for (const u of db.prepare('SELECT id, username, role, status, email, created_at FROM users').all()) {
  console.log('  ' + u.username + ' | ' + u.role + ' | ' + u.status + ' | ' + u.email);
}

console.log('\n=== kv_rows 各键 + 条目数 ===');
for (const r of db.prepare('SELECT key, data FROM kv_rows').all()) {
  const d = JSON.parse(r.data);
  console.log('  ' + r.key + '  → ' + (Array.isArray(d) ? d.length + ' 条' : '对象'));
}

console.log('\n=== ai_history ===');
for (const a of db.prepare('SELECT user_id, kind, updated_at FROM ai_history').all()) {
  console.log('  ' + a.user_id + ' | ' + a.kind + ' | ' + a.updated_at);
}

db.close();
console.log('\n查看完成（只读，未改动任何数据）');
