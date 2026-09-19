'use strict';

const path = require('path');
const express = require('express');
const { analyze } = require('./lib/analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/analyze
 * body: { rules: [{ method: string, path: string }] }
 * 规则在数组中的顺序即优先级（索引 0 最先匹配）。
 */
app.post('/api/analyze', (req, res) => {
  const rules = req.body && req.body.rules;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: '请求体必须为 { rules: [...] }' });
  }
  if (rules.length > 500) {
    return res.status(400).json({ error: '规则数量不能超过 500 条' });
  }
  res.json(analyze(rules));
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`路由冲突实验室已启动: http://localhost:${PORT}`);
});
