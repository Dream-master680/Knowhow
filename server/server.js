/**
 * KnowHow 后端入口（Express）
 * ─────────────────────────────────────────────
 * · 托管前端静态文件（同源，无 CORS）
 * · 挂载 /api/auth /api/users /api/sync /api/ai 路由
 * · 非 /api 的 GET 回退 index.html（hash 路由实际用不到，防御性深链）
 *
 * 启动：cd server && npm install && npm start
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const { initDb } = require('./db');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const syncRoutes = require('./routes/sync');
const aiRoutes = require('./routes/ai');

const db = initDb(); // 建表 + 首启种子

const app = express();
app.use(express.json({ limit: '5mb' })); // 默认 100kb 不够论坛/聊天快照

// 托管前端（项目根目录）
app.use(express.static(path.join(__dirname, '..')));

app.use('/api/auth', authRoutes(db));
app.use('/api/users', userRoutes(db));
app.use('/api', syncRoutes(db)); // /api/bootstrap + /api/sync
app.use('/api', aiRoutes());     // /api/ai

// 非 /api 的 GET 回退 index.html
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('KnowHow server running at http://localhost:' + PORT);
});
