'use strict';

/*
 * 前端冒烟测试：用最小 DOM/fetch stub 在 Node 中加载 public/app.js，
 * 模拟 打开页面 -> 实时分析 -> 生成修复方案 -> 一次应用 -> 再次实时分析，
 * 校验：按钮显隐、预览中的前后位置/不可避免遮蔽数、应用后的规则顺序与本地保存。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { analyze } = require('../lib/analyzer');

// ---------- 最小 DOM stub ----------
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    hidden: false,
    disabled: false,
    _text: '',
    _html: '',
    className: '',
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        if (force === undefined) force = !this._set.has(c);
        force ? this._set.add(c) : this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    attrs: {},
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.children.push(c)); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || {})); },
    querySelector(sel) {
      const all = [];
      const walk = (n) => n.children.forEach((c) => { all.push(c); walk(c); });
      walk(this);
      if (sel === '.status-cell') return all.find((c) => c.className === 'status-cell');
      return all.find((c) => c.className === sel.slice(1));
    },
    querySelectorAll() {
      const all = [];
      const walk = (n) => n.children.forEach((c) => { all.push(c); walk(c); });
      walk(this);
      return all;
    },
    focus() {}, select() {}, click() { this.dispatch('click'); },
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join('');
      return this._text;
    },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this.children = []; },
  };
  return el;
}

const ids = [
  'rules-list', 'conflicts', 'summary', 'toast', 'fix-plan', 'btn-fix',
  'btn-add', 'btn-reset', 'btn-export', 'btn-import', 'file-import',
];
const els = {};
for (const id of ids) els[id] = makeEl('div');

const storage = {};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  document: {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
  },
  localStorage: {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  },
  navigator: {},
  fetch: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => analyze(body.rules),
    };
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
vm.runInContext(code, sandbox);

// app.js 启动时会 scheduleAnalyze(true) -> 异步 fetch
(async () => {
  await new Promise((r) => setTimeout(r, 30));

  // 1) 默认示例存在 4 条遮蔽 -> 修复按钮可见
  assert.strictEqual(els['btn-fix'].hidden, false, '存在遮蔽时应显示“生成修复方案”按钮');

  // 2) 打开修复方案预览
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(els['fix-plan'].hidden, false, '预览面板应显示');
  const previewText = els['fix-plan'].textContent;
  assert.ok(previewText.includes('调整前遮蔽'), '应展示调整前位置指标');
  assert.ok(previewText.includes('调整后遮蔽'), '应展示调整后位置指标');
  assert.ok(previewText.includes('仍不可避免的遮蔽'), '应展示不可避免遮蔽数量');
  assert.ok(previewText.includes('4'), '默认示例应显示 4 条调整前遮蔽');
  // 默认示例全部可修复
  assert.ok(previewText.includes('一次应用（移动 4 条）'), '应显示一次应用按钮及移动数');
  assert.ok(!/仍将存在的/.test(previewText), '全可修复时不应有残留遮蔽区块');

  // 3) 一次应用
  const applyBtn = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  assert.ok(applyBtn, '应找到“一次应用”按钮');
  applyBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));

  // 应用后规则顺序：:id -> /users/* -> /api/* ...
  const saved = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved[0].path, '/api/users/:id');
  assert.strictEqual(saved[1].path, '/api/users/*');
  assert.strictEqual(saved[2].path, '/api/*');
  assert.strictEqual(saved[3].path, '/assets/css/*');
  assert.strictEqual(saved[4].path, '/assets/*');
  assert.strictEqual(els['fix-plan'].hidden, true, '应用后应收起预览');
  assert.strictEqual(els['btn-fix'].hidden, true, '无遮蔽时修复按钮应隐藏');

  // 4) 不可消除场景：导入含等价重复规则的规则集，预览必须如实标注残留遮蔽
  sandbox.FileReader = class {
    readAsText() {
      this.result = JSON.stringify({
        format: 'route-conflict-lab/v1',
        rules: [
          { method: 'GET', path: '/*' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/a' },
          { method: 'GET', path: '/b' },
        ],
      });
      this.onload();
    }
  };
  els['file-import'].dispatch('change', { target: { files: [{}], value: '' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(els['btn-fix'].hidden, false, '含遮蔽时应显示修复按钮');
  els['btn-fix'].dispatch('click');
  await new Promise((r) => setTimeout(r, 10));
  const text2 = els['fix-plan'].textContent;
  // 原始：/* 遮蔽 3 条（/a、/a、/b）+ 两条 /a 互相遮蔽 = 4；可修复 3，残留 1
  assert.ok(text2.includes('不可通过排序消除的等价规则'), '应出现不可消除等价组区块');
  assert.ok(/应用后仍将存在的 1 条遮蔽/.test(text2), '应如实列出 1 条残留遮蔽');
  assert.ok(text2.includes('移动 4 条'), '等价组前移 + /* 后移，共 4 条位置变化');
  // 建议顺序：等价的 /a、/a 在前，随后 /b，最宽泛的 /* 最后
  const fpExpect = analyze([
    { method: 'GET', path: '/*' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/a' },
    { method: 'GET', path: '/b' },
  ]).fixPlan;
  assert.deepStrictEqual(
    fpExpect.order.map((i) => ['/*', '/a', '/a', '/b'][i]),
    ['/a', '/a', '/b', '/*']
  );
  // 应用一次：顺序变为 /a /a /b /*（/* 移到最后），遮蔽 4 -> 1
  const applyBtn2 = els['fix-plan']
    .querySelectorAll()
    .find((c) => c.tagName === 'button' && String(c.textContent).includes('一次应用'));
  applyBtn2.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  const saved2 = JSON.parse(storage['route-conflict-lab.rules.v1']);
  assert.strictEqual(saved2[3].path, '/*', '最宽泛的 /* 应移至末尾');
  assert.strictEqual(els['btn-fix'].hidden, false, '仍有 1 条不可避免遮蔽，按钮应保持可见');

  console.log('前端冒烟测试全部通过 ✓');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
