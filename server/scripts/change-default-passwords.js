/**
 * 部署后一次性工具：改掉内置种子账号的默认密码（admin/lawyer/user）。
 *
 * 用法：cd server && node scripts/change-default-passwords.js
 *          → 随机生成 12 位强密码，打印一次（请当场保存）
 *       node scripts/change-default-passwords.js --set admin=你的密码 lawyer=你的密码 user=你的密码
 *          → 使用你自己指定的密码（要求长度≥8、不能是公开默认值）
 * 两种模式都会：吊销全部会话，所有用户需重新登录。
 *
 * 忘了/丢了密码怎么办：再跑一次脚本即可换新密码（旧密码立即作废），永远不会锁死。
 * 安全：脚本本身不含任何密码，可放心提交/存放。
 */
const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword } = require('../auth');

// DB_PATH 可覆盖数据库路径（测试/恢复场景用；默认用 server/data.db）
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data.db'));
db.pragma('busy_timeout = 5000');

const ACCOUNTS = ['admin', 'lawyer', 'user'];
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const PUBLIC_DEFAULTS = ['admin123', '123456', '12345678', 'password', 'admin']; // 公开仓库里出现过的，禁止使用

/** 12 位随机密码（去易混淆字符，保证至少一个数字） */
function strong() {
  let s = '';
  for (let i = 0; i < 12; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  if (!/\d/.test(s)) s = s.slice(0, 11) + '23456789'[Math.floor(Math.random() * 8)];
  return s;
}

/** 解析 --set admin=xxx lawyer=yyy 形式 */
function parseSetArgs(argv) {
  const set = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set') {
      for (let j = i + 1; j < argv.length; j++) {
        if (argv[j].startsWith('-')) break;
        const eq = argv[j].indexOf('=');
        if (eq > 0) set[argv[j].slice(0, eq)] = argv[j].slice(eq + 1);
      }
      break;
    }
  }
  return set;
}

/** 校验自定义密码：长度≥8、非公开默认值、非他人同密码 */
function validatePw(u, pw, set) {
  if (typeof pw !== 'string' || pw.length < 8) {
    return '密码过短（至少 8 位）';
  }
  if (PUBLIC_DEFAULTS.indexOf(pw.toLowerCase()) !== -1) {
    return '不能用公开默认密码（' + PUBLIC_DEFAULTS.join('/') + '）';
  }
  for (const [k, v] of Object.entries(set)) {
    if (k !== u && v === pw) return '两个账号不能设相同密码';
  }
  return null;
}

const setMap = parseSetArgs(process.argv.slice(2));
const update = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?');
const now = Date.now();
let changed = 0;

console.log(setMap && Object.keys(setMap).length
  ? '模式：使用你指定的密码'
  : '模式：随机生成（请保存下方打印的密码）');

for (const u of ACCOUNTS) {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (!row) { console.log('[跳过] 账号 ' + u + ' 不存在'); continue; }
  let pw, note;
  if (setMap && setMap[u] !== undefined) {
    const err = validatePw(u, setMap[u], setMap);
    if (err) { console.log('[拒绝] ' + u + ': ' + err); continue; }
    pw = setMap[u];
    note = '（你指定的密码）';
  } else {
    pw = strong();
    note = '';
  }
  update.run(hashPassword(pw), now, u);
  console.log('[已改] ' + u + '  新密码: ' + pw + note);
  changed++;
}

if (changed > 0) {
  db.prepare('DELETE FROM sessions').run();
  console.log('[已吊销] 所有会话，所有用户需重新登录');
}
db.close();
console.log('完成。随机模式请立即保存密码；此脚本可随时删除。');
