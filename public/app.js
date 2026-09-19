'use strict';

/* 路由冲突实验室 —— 原生前端
 * 规则编辑后（含拖动排序）防抖调用 POST /api/analyze 实时重算。
 */

const STORAGE_KEY = 'route-conflict-lab.rules.v1';

const DEFAULT_RULES = [
  { method: 'GET', path: '/api/*' },
  { method: 'GET', path: '/api/users/*' },
  { method: 'GET', path: '/api/users/:id' },
  { method: 'GET', path: '/assets/*' },
  { method: 'GET', path: '/assets/css/*' },
  { method: 'GET', path: '/a/*/c' },
  { method: 'GET', path: '/*/b/c' },
  { method: 'POST', path: '/api/users' },
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'];

const listEl = document.getElementById('rules-list');
const conflictsEl = document.getElementById('conflicts');
const summaryEl = document.getElementById('summary');
const fixEl = document.getElementById('fix-plan');
const toastEl = document.getElementById('toast');
const rulesPanelEl = document.querySelector('.rules-panel');

let rules = loadRules();
let dragIndex = null;
let lastAnalysis = null;
let debounceTimer = null;
let previewOrder = null; // 非 null 表示正在预览修复方案的建议顺序

function loadRules() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.path === 'string')) {
        return parsed.map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: r.path,
        }));
      }
    }
  } catch (_e) {
    /* 存储损坏时回退到默认示例 */
  }
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

function saveRules() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch (_e) {
    /* 忽略隐私模式等写入失败 */
  }
}

function showToast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

/* ---------------- 规则列表渲染 ---------------- */

function renderRules() {
  rulesPanelEl.classList.remove('previewing');
  listEl.innerHTML = '';
  rules.forEach((rule, i) => {
    const li = document.createElement('li');
    li.className = 'rule-row';
    li.dataset.index = String(i);
    li.draggable = true;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.textContent = '⣿';
    grip.title = '拖动以调整优先级';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const method = document.createElement('select');
    method.className = 'rule-method';
    method.setAttribute('aria-label', `规则 ${i + 1} 的请求方法`);
    for (const m of METHODS) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if ((rule.method || 'GET').toUpperCase() === m) opt.selected = true;
      method.appendChild(opt);
    }
    method.addEventListener('change', () => {
      rules[i].method = method.value;
      saveRules();
      scheduleAnalyze();
    });

    const pathWrap = document.createElement('span');
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'path-input';
    pathInput.value = rule.path;
    pathInput.placeholder = '/users/:id';
    pathInput.setAttribute('aria-label', `规则 ${i + 1} 的路径模式`);
    pathInput.spellcheck = false;
    pathInput.addEventListener('input', () => {
      rules[i].path = pathInput.value;
      saveRules();
      scheduleAnalyze();
    });
    pathWrap.appendChild(pathInput);

    const status = document.createElement('span');
    status.className = 'status-cell';

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.type = 'button';
    del.textContent = '✕';
    del.title = '删除该规则';
    del.addEventListener('click', () => {
      rules.splice(i, 1);
      saveRules();
      renderRules();
      scheduleAnalyze(true);
    });

    li.append(grip, idx, method, pathWrap, status, del);
    attachDragHandlers(li);
    listEl.appendChild(li);
  });
  paintAnalysis();
}

/* ---------------- 拖拽排序（HTML5 DnD） ---------------- */

function attachDragHandlers(li) {
  li.addEventListener('dragstart', (e) => {
    dragIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(dragIndex));
    } catch (_e) {
      /* 某些浏览器要求 setData，失败可忽略 */
    }
  });

  li.addEventListener('dragend', () => {
    dragIndex = null;
    document.querySelectorAll('.rule-row').forEach((el) => {
      el.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  });

  li.addEventListener('dragover', (e) => {
    if (dragIndex === null || dragIndex === Number(li.dataset.index)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;
    li.classList.toggle('drop-above', above);
    li.classList.toggle('drop-below', !above);
  });

  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-above', 'drop-below');
  });

  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const targetIndex = Number(li.dataset.index);
    if (dragIndex === null || dragIndex === targetIndex) return;
    const rect = li.getBoundingClientRect();
    const above = e.clientY < rect.top + rect.height / 2;

    const [moved] = rules.splice(dragIndex, 1);
    let insertAt = targetIndex;
    if (dragIndex < targetIndex) insertAt = targetIndex - 1;
    if (!above) insertAt += 1;
    rules.splice(insertAt, 0, moved);

    saveRules();
    renderRules();
    scheduleAnalyze(true);
  });
}

/* ---------------- 分析 ---------------- */

function scheduleAnalyze(immediate = false) {
  clearTimeout(debounceTimer);
  if (immediate) {
    analyze();
    return;
  }
  debounceTimer = setTimeout(analyze, 150);
}

async function analyze() {
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    lastAnalysis = await resp.json();
    paintAnalysis();
  } catch (err) {
    summaryEl.innerHTML = '';
    fixEl.innerHTML = '';
    conflictsEl.innerHTML =
      `<div class="empty-state">分析失败：${escapeHTML(err.message)}</div>`;
  }
}

function paintAnalysis() {
  if (!lastAnalysis) return;
  const { rules: results, conflicts, summary, fix } = lastAnalysis;

  // 行高亮 + 状态徽标
  listEl.querySelectorAll('.rule-row').forEach((row) => {
    const i = Number(row.dataset.index);
    const r = results[i];
    if (!r) return;
    row.classList.toggle('row-invalid', !r.valid);
    row.classList.toggle('row-shadow', r.shadows.length > 0);
    row.classList.toggle(
      'row-partial',
      r.overlaps.length > 0 && r.shadows.length === 0
    );

    const status = row.querySelector('.status-cell');
    status.innerHTML = '';
    if (!r.valid) {
      const badge = badgeEl('invalid', '语法错误');
      status.appendChild(badge);
      const err = document.createElement('span');
      err.className = 'row-error';
      err.textContent = r.errors.join('；');
      status.appendChild(err);
    } else if (r.shadows.length > 0) {
      status.appendChild(badgeEl('shadow', `遮蔽 ${r.shadows.length} 条`));
      if (r.overlaps.length > 0) {
        status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
      }
    } else if (r.overlaps.length > 0) {
      status.appendChild(badgeEl('partial', `重叠 ${r.overlaps.length} 条`));
    } else {
      status.appendChild(badgeEl('ok', '无冲突'));
    }
  });

  // 摘要
  summaryEl.innerHTML = '';
  const pill = (cls, text, n) => {
    const el = document.createElement('span');
    el.className = `pill ${cls}`;
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = n;
    el.append(num, ` ${text}`);
    return el;
  };
  summaryEl.appendChild(pill('pill-shadow', '完全遮蔽', summary.shadow));
  summaryEl.appendChild(pill('pill-partial', '部分重叠', summary.partial));
  if (summary.total === 0) {
    summaryEl.appendChild(pill('pill-ok', '无冲突', ''));
  }

  // 修复方案（建议顺序）
  renderFixPlan(fix);

  // 冲突卡片
  conflictsEl.innerHTML = '';
  if (conflicts.length === 0) {
    conflictsEl.innerHTML =
      '<div class="empty-state"><span class="big">✅</span>未发现冲突。<br/>不同方法的规则互不影响；尝试调整顺序或加入 <code>/*</code> 通配符。</div>';
    return;
  }
  for (const c of conflicts) {
    conflictsEl.appendChild(renderConflictCard(c));
  }
}

/* ---------------- 修复方案（建议顺序） ---------------- */

function strongNum(text, cls) {
  const s = document.createElement('strong');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function renderFixPlan(fix) {
  fixEl.innerHTML = '';
  if (!fix || fix.shadowsBefore === 0) return;

  const card = document.createElement('div');
  card.className = 'fix-card';

  const head = document.createElement('div');
  head.className = 'fix-head';
  const title = document.createElement('span');
  title.className = 'fix-title';
  title.textContent = '🛠 修复方案（重新排序）';
  head.appendChild(title);
  card.appendChild(head);

  // 统计：可修复 / 不可避免
  const stats = document.createElement('div');
  stats.className = 'fix-stats';
  const line1 = document.createElement('div');
  line1.append('当前 ', strongNum(String(fix.shadowsBefore), 'bad'), ' 处完全遮蔽。');
  stats.appendChild(line1);
  const line2 = document.createElement('div');
  if (fix.fixableShadows > 0) {
    line2.append(strongNum(String(fix.fixableShadows), 'good'), ' 处可通过调整顺序修复');
    if (fix.unavoidableShadows > 0) {
      line2.append(
        '，另有 ',
        strongNum(String(fix.unavoidableShadows), 'bad'),
        ' 处由语言等价的规则导致，无法通过排序消除。'
      );
    } else {
      line2.append('，调整后不再存在完全遮蔽。');
    }
  } else {
    line2.append(
      strongNum(String(fix.unavoidableShadows), 'bad'),
      ' 处遮蔽由语言等价的规则导致，无法通过排序消除（需删除或修改重复规则）。'
    );
  }
  stats.appendChild(line2);
  card.appendChild(stats);

  // 位置变化明细（调整前 → 调整后）
  if (fix.changed) {
    const movesBox = document.createElement('div');
    movesBox.className = 'fix-moves';
    const mt = document.createElement('div');
    mt.className = 'fix-moves-title';
    mt.textContent = `建议调整（${fix.moves.length} 条规则位置变化，#调整前 → #调整后）：`;
    movesBox.appendChild(mt);
    for (const mv of fix.moves) {
      const row = document.createElement('div');
      row.className = 'fix-move-row';
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = `#${mv.from + 1} → #${mv.to + 1}`;
      const m = document.createElement('span');
      m.className = 'm';
      m.textContent = mv.method;
      const p = document.createElement('span');
      p.className = 'p';
      p.textContent = mv.path;
      row.append(pos, m, p);
      movesBox.appendChild(row);
    }
    card.appendChild(movesBox);
  }

  // 等价组：无法通过排序消除，如实标注
  if (fix.equivalentGroups.length > 0) {
    const box = document.createElement('div');
    box.className = 'fix-groups';
    const gt = document.createElement('div');
    gt.className = 'fix-groups-title';
    gt.textContent =
      '⚠ 以下规则路径语言等价，无论如何排序都互相遮蔽，需删除或修改重复规则：';
    box.appendChild(gt);
    for (const g of fix.equivalentGroups) {
      const row = document.createElement('div');
      row.className = 'fix-group-row';
      g.members.forEach((mb, mi) => {
        if (mi > 0) {
          const eq = document.createElement('span');
          eq.className = 'eq';
          eq.textContent = '≡';
          row.appendChild(eq);
        }
        const item = document.createElement('span');
        item.textContent = `#${mb.index + 1} ${mb.method} ${mb.path}`;
        row.appendChild(item);
      });
      box.appendChild(row);
    }
    card.appendChild(box);
  }

  // 操作区：预览 -> 一次应用
  if (fix.changed) {
    const actions = document.createElement('div');
    actions.className = 'fix-actions';
    if (previewOrder === null) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn';
      previewBtn.type = 'button';
      previewBtn.textContent = '👁 预览新顺序';
      previewBtn.addEventListener('click', () => {
        previewOrder = lastAnalysis.fix.order.slice();
        renderPreview();
        renderFixPlan(lastAnalysis.fix);
      });
      actions.appendChild(previewBtn);
    } else {
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn btn-primary';
      applyBtn.type = 'button';
      applyBtn.textContent = '✔ 应用新顺序';
      applyBtn.addEventListener('click', applyPreview);
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消预览';
      cancelBtn.addEventListener('click', cancelPreview);
      const note = document.createElement('span');
      note.className = 'fix-note';
      note.textContent = '左侧列表为建议顺序预览，应用后将重新分析并保存。';
      actions.append(applyBtn, cancelBtn, note);
    }
    card.appendChild(actions);
  }

  fixEl.appendChild(card);
}

/** 预览模式：规则列表按建议顺序静态渲染，并标注调整前位置 */
function renderPreview() {
  rulesPanelEl.classList.add('previewing');
  listEl.innerHTML = '';
  previewOrder.forEach((oldIdx, newIdx) => {
    const rule = rules[oldIdx];
    const li = document.createElement('li');
    li.className = 'rule-row preview-row';
    if (oldIdx !== newIdx) li.classList.add('preview-moved');

    const grip = document.createElement('span');
    grip.className = 'grip';

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = newIdx + 1;

    const method = document.createElement('span');
    method.className = 'preview-method';
    method.textContent = (rule.method || 'GET').toUpperCase();

    const path = document.createElement('span');
    path.className = 'preview-path';
    path.textContent = rule.path;

    const move = document.createElement('span');
    move.className = 'preview-move' + (oldIdx !== newIdx ? ' moved' : '');
    move.textContent = oldIdx !== newIdx ? `原位置 #${oldIdx + 1}` : '位置不变';

    li.append(grip, idx, method, path, move, document.createElement('span'));
    listEl.appendChild(li);
  });
}

function cancelPreview() {
  if (previewOrder === null) return;
  previewOrder = null;
  renderRules();
}

/** 一次应用：按建议顺序重排，沿用现有实时分析与本地保存 */
function applyPreview() {
  if (previewOrder === null) return;
  rules = previewOrder.map((i) => rules[i]);
  previewOrder = null;
  saveRules();
  renderRules();
  scheduleAnalyze(true);
  showToast('已应用建议顺序', 'ok');
}

function badgeEl(kind, text) {
  const b = document.createElement('span');
  b.className = `badge badge-${kind}`;
  b.textContent = text;
  return b;
}

function renderConflictCard(c) {
  const card = document.createElement('div');
  card.className = `conflict-card c-${c.type}`;

  const top = document.createElement('div');
  top.className = 'conflict-top';
  const type = document.createElement('span');
  type.className = 'conflict-type';
  type.textContent = c.type === 'shadow' ? '⛔ 完全遮蔽' : '⚠️ 部分重叠';
  const desc = document.createElement('span');
  desc.className = 'conflict-desc';
  desc.textContent =
    c.type === 'shadow'
      ? `#${c.higher.index + 1} 命中后，#${c.lower.index + 1} 永远不会被执行`
      : `#${c.higher.index + 1} 与 #${c.lower.index + 1} 在部分路径上同时命中`;
  top.append(type, desc);

  const pair = document.createElement('div');
  pair.className = 'route-pair';
  pair.appendChild(routeLine('高优先级', c.higher));
  pair.appendChild(routeLine('低优先级', c.lower));

  const ex = document.createElement('div');
  ex.className = 'example-box';
  const exLabel = document.createElement('span');
  exLabel.className = 'ex-label';
  exLabel.textContent = '最短同时命中';
  const exValue = document.createElement('span');
  exValue.className = 'ex-value';
  exValue.textContent = c.example;
  exValue.title = '点击复制';
  exValue.addEventListener('click', () => {
    navigator.clipboard
      ?.writeText(c.example)
      .then(() => showToast(`已复制：${c.example}`, 'ok'))
      .catch(() => showToast('复制失败，请手动选择', 'error'));
  });
  ex.append(exLabel, exValue);

  card.append(top, pair, ex);
  return card;
}

function routeLine(tag, endpoint) {
  const wrap = document.createElement('span');
  wrap.className = 'rp';
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  const method = document.createElement('span');
  method.className = 'm';
  method.textContent = endpoint.method;
  const p = document.createElement('span');
  p.textContent = endpoint.path;
  p.title = `规则 #${endpoint.index + 1}`;
  wrap.append(t, method, p);
  return wrap;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------------- 导入 / 导出 / 新增 / 重置 ---------------- */

document.getElementById('btn-add').addEventListener('click', () => {
  cancelPreview();
  rules.push({ method: 'GET', path: '/new/route/:id' });
  saveRules();
  renderRules();
  scheduleAnalyze(true);
  const inputs = listEl.querySelectorAll('.path-input');
  const last = inputs[inputs.length - 1];
  last.focus();
  last.select();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  cancelPreview();
  rules = DEFAULT_RULES.map((r) => ({ ...r }));
  saveRules();
  renderRules();
  scheduleAnalyze(true);
  showToast('已恢复默认示例', 'ok');
});

document.getElementById('btn-export').addEventListener('click', () => {
  const payload = {
    format: 'route-conflict-lab/v1',
    exportedAt: new Date().toISOString(),
    rules,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'route-rules.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${rules.length} 条规则`, 'ok');
});

document.getElementById('btn-import').addEventListener('click', () => {
  cancelPreview();
  document.getElementById('file-import').click();
});

document.getElementById('file-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result));
      // 兼容裸数组与 { rules: [...] } 两种格式
      const incoming = Array.isArray(data) ? data : data.rules;
      if (!Array.isArray(incoming)) {
        throw new Error('JSON 中未找到 rules 数组');
      }
      const cleaned = incoming
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({
          method: typeof r.method === 'string' ? r.method : 'GET',
          path: String(r.path ?? ''),
        }));
      if (cleaned.length === 0) throw new Error('规则列表为空');
      rules = cleaned;
      saveRules();
      renderRules();
      scheduleAnalyze(true);
      showToast(`已导入 ${cleaned.length} 条规则`, 'ok');
    } catch (err) {
      showToast(`导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

/* ---------------- 启动 ---------------- */
renderRules();
scheduleAnalyze(true);
