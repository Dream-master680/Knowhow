/**
 * KnowHow 服务端首启种子数据
 * ─────────────────────────────────────────────
 * 与前端 app.js seedIfEmpty 的数组内容保持一致，保证新设备拿到相同内容。
 * 仅含「服务端托管键」：users + 论坛 / 社区 / 问答。
 * 新闻 / 电影 / 律师 / 法条等展示内容仍由前端本地播种，不在此处。
 */
const DAY = 86400000;
const HOUR = 3600000;

function nid() {
  return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const users = [
  { id: 'admin_superadmin', username: 'admin', password: 'admin123', email: 'admin@example.com', role: 'superadmin', status: 'active', createdAt: Date.now() - 100000 },
  { id: 'lawyer_demo', username: 'lawyer', password: '123456', email: 'lawyer@example.com', role: 'lawyer', status: 'active', createdAt: Date.now() - 80000 },
  { id: 'user_demo', username: 'user', password: '123456', email: 'user@example.com', role: 'user', status: 'active', createdAt: Date.now() - 70000 }
];

/** 服务端托管键 → 首启内容（key 与前端 localStorage key 一致） */
const kvRows = {
  'ln_forum_posts_v1': [
    { id: nid(), title: '如何理解居住权？', content: '居住权与所有权的关系如何把握？', createdAt: Date.now() - DAY, replies: [{ id: nid(), content: '可参考民法典权利体系章节。', createdAt: Date.now() - 86000000 }] },
    { id: nid(), title: '企业收到律师函后第一步该怎么做？', content: '是先内部排查还是立即回函？有没有标准流程建议？', createdAt: Date.now() - 4 * DAY, views: 186, likes: 24, replies: [{ id: nid(), text: '先保全证据并启动合规核查，再由法务统一口径回复。', createdAt: Date.now() - 3 * DAY }] },
    { id: nid(), title: '劳动仲裁证据怎么准备最有效？', content: '聊天记录、打卡记录、工资流水如何整理更有说服力？', createdAt: Date.now() - 3 * DAY, views: 243, likes: 31, replies: [{ id: nid(), text: '建议按"劳动关系证明-劳动事实-损失结果"三层归档。', createdAt: Date.now() - 2 * DAY }] },
    { id: nid(), title: '小微企业合同模板需要重点关注哪些条款？', content: '违约责任、争议解决、付款节点之外还有哪些高风险点？', createdAt: Date.now() - 2 * DAY, views: 169, likes: 18, replies: [{ id: nid(), text: '建议加入数据合规与知识产权约定，避免后期争议。', createdAt: Date.now() - 36 * HOUR }] }
  ],

  'ln_community_feed_v1': [
    { id: nid(), text: '法治宣传周活动顺利开展！', tags: ['活动'], likes: 3, createdAt: Date.now() - 3600000 },
    { id: nid(), text: '"法治进校园"主题直播活动顺利完成，累计观看约 1.2 万人次。', tags: ['活动', '直播'], likes: 42, createdAt: Date.now() - 5 * 3600000 },
    { id: nid(), text: '本周发布《劳动合同常见风险清单》图解版，欢迎转发。', tags: ['普法', '劳动法'], likes: 29, createdAt: Date.now() - 11 * 3600000 },
    { id: nid(), text: '律师志愿团完成社区公益咨询 86 人次。', tags: ['公益', '律师'], likes: 35, createdAt: Date.now() - 26 * 3600000 }
  ],

  'ln_qa_items_v1': [
    { id: nid(), question: '劳动合同到期公司不续签怎么办？', answers: [{ id: nid(), text: '依法支付经济补偿，注意证据留存。' }], createdAt: Date.now() - 7200000 },
    { id: nid(), question: '试用期单位可以随时辞退员工吗？', answers: [{ id: nid(), text: '不可以，仍需证明不符合录用条件并履行法定程序。' }], createdAt: Date.now() - 15 * 3600000 },
    { id: nid(), question: '网购纠纷可以向哪里投诉维权？', answers: [{ id: nid(), text: '可向平台客服、12315、市场监管部门逐级反映并留存凭证。' }], createdAt: Date.now() - 22 * 3600000 },
    { id: nid(), question: '离职后公司拖欠工资怎么办？', answers: [{ id: nid(), text: '先书面催告，仍不支付可申请劳动仲裁并主张经济补偿。' }], createdAt: Date.now() - 31 * 3600000 }
  ]
};

module.exports = { users, kvRows };
