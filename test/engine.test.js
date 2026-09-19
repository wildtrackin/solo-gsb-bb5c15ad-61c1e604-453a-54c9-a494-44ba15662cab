'use strict';

const assert = require('assert');
const { analyze, covers, buildDFA, parsePath, shortestIntersectionWord } = require('../lib/analyzer');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function dfa(path) {
  const { tokens } = parsePath(path);
  return buildDFA(tokens);
}
function coversP(a, b) {
  return covers(dfa(a), dfa(b));
}
function shortest(a, b) {
  return shortestIntersectionWord(dfa(a), dfa(b));
}

// ---------- 覆盖关系 ----------
check('* 覆盖一切', () => {
  assert.strictEqual(coversP('/*', '/a/b/c'), true);
  assert.strictEqual(coversP('/*', '/'), true);
});
check('具体路径不被 * 反向覆盖之外：/a 不覆盖 /*', () => {
  assert.strictEqual(coversP('/a', '/*'), false);
});
check('/users/:id 覆盖 /users/123 这类单段', () => {
  assert.strictEqual(coversP('/users/:id', '/users/123'), true);
  assert.strictEqual(coversP('/users/:id', '/users/123/posts'), false);
});
check('/users/* 覆盖 /users/:id 及其子路径', () => {
  assert.strictEqual(coversP('/users/*', '/users/:id'), true);
  assert.strictEqual(coversP('/users/*', '/users/:id/posts'), true);
  assert.strictEqual(coversP('/users/*', '/users'), true);
  assert.strictEqual(coversP('/users/*', '/orders/1'), false);
});
check('相同模式互相覆盖', () => {
  assert.strictEqual(coversP('/a/:x', '/a/:y'), true);
});
check('/ 根路径只覆盖自己', () => {
  assert.strictEqual(coversP('/', '/'), true);
  assert.strictEqual(coversP('/', '/a'), false);
  assert.strictEqual(coversP('/*', '/'), true);
});
check('字面量分流不覆盖', () => {
  assert.strictEqual(coversP('/a/x', '/b/x'), false);
});
check('/api/* 与 /api/:v/health：参数需非空，不覆盖无段情形但覆盖有段', () => {
  assert.strictEqual(coversP('/api/*', '/api/:v/health'), true);
  assert.strictEqual(coversP('/api/:v/health', '/api/*'), false);
});
check('双通配 /a/*/b/* 覆盖情形', () => {
  assert.strictEqual(coversP('/a/*/b/*', '/a/x/b/y/z'), true);
  assert.strictEqual(coversP('/a/*/b/*', '/a/b'), true); // 两个 * 均匹配零段
  assert.strictEqual(coversP('/a/*/b/*', '/a/x/c'), false);
});

// ---------- 最短交集路径 ----------
check('交集最短：/users/:id 与 /users/* -> /users/a', () => {
  assert.strictEqual(shortest('/users/:id', '/users/*'), '/users/a');
});
check('交集最短：/a/* 与 /*/b -> /a/b（单段同时满足）', () => {
  assert.strictEqual(shortest('/a/*', '/*/b'), '/a/b');
});
check('交集最短：根 / 与 /* -> /', () => {
  assert.strictEqual(shortest('/', '/*'), '/');
});
check('无交集返回 null：/a 与 /b', () => {
  assert.strictEqual(shortest('/a', '/b'), null);
});
check('无交集返回 null：/a/x 与 /a/:p/y（段数不同）', () => {
  assert.strictEqual(shortest('/a/x', '/a/:p/y'), null);
});
check('字典序并列取最小：/x/:p 与 /x/* 可取任意字面量时取 a', () => {
  assert.strictEqual(shortest('/x/:p', '/x/*'), '/x/a');
});
check('字面量优先于自由值成为最短路径一部分', () => {
  // /z/:p vs /z/*：两条都在 /z/<段> 命中，自由值 a < z
  assert.strictEqual(shortest('/z/:p', '/z/*'), '/z/a');
});
check('/a/* 与 /:p/b 最短交集为 /a/b', () => {
  assert.strictEqual(shortest('/a/*', '/:p/b'), '/a/b');
});

// ---------- analyze 集成 ----------
function ids(conflicts, kind) {
  return conflicts.filter((c) => c.type === kind).map((c) => [c.higher.id, c.lower.id]);
}

check('analyze: 完全遮蔽检测 + 示例', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'GET', path: '/users/:id' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.summary.partial, 0);
  assert.deepStrictEqual(ids(res.conflicts, 'shadow'), [['a', 'b']]);
  assert.strictEqual(res.conflicts[0].example, 'GET /users/a');
});

check('analyze: 部分重叠检测', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/a/*' },
    { id: 'b', method: 'GET', path: '/*/b' },
  ]);
  assert.strictEqual(res.summary.shadow, 0);
  assert.strictEqual(res.summary.partial, 1);
  assert.strictEqual(res.conflicts[0].example, 'GET /a/b');
});

check('analyze: 不同方法互不冲突', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'POST', path: '/users/*' },
  ]);
  assert.strictEqual(res.summary.total, 0);
});

check('analyze: ALL 与任意具体方法冲突', () => {
  const res = analyze([
    { id: 'a', method: 'ALL', path: '/users/:id' },
    { id: 'b', method: 'DELETE', path: '/users/:id' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.conflicts[0].method, 'DELETE');
});

check('analyze: 静态规则被通配规则遮蔽，示例为静态字面量', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: '/*' },
    { id: 'b', method: 'GET', path: '/health' },
  ]);
  assert.strictEqual(res.summary.shadow, 1);
  assert.strictEqual(res.conflicts[0].example, 'GET /health');
});

check('analyze: 无效规则被跳过并给出错误', () => {
  const res = analyze([
    { id: 'a', method: 'GET', path: 'users/missing-slash' },
    { id: 'b', method: 'GET', path: '/ok' },
  ]);
  assert.strictEqual(res.rules[0].valid, false);
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.summary.total, 0);
});

check('analyze: 优先级由数组顺序决定，交换后遮蔽方向相反', () => {
  const r1 = analyze([
    { id: 'a', method: 'GET', path: '/users/*' },
    { id: 'b', method: 'GET', path: '/users/:id' },
  ]);
  const r2 = analyze([
    { id: 'b', method: 'GET', path: '/users/:id' },
    { id: 'a', method: 'GET', path: '/users/*' },
  ]);
  // 互换优先级后：:id 不遮蔽 *，仅在 /users/:id 单段处重叠
  assert.strictEqual(r1.conflicts[0].type, 'shadow');
  assert.strictEqual(r2.conflicts[0].type, 'partial');
  assert.strictEqual(r2.conflicts[0].example, 'GET /users/a');
});

check('analyze: 默认实验室示例集结果稳定', () => {
  const res = analyze([
    { method: 'GET', path: '/api/*' },
    { method: 'GET', path: '/api/users/*' },
    { method: 'GET', path: '/api/users/:id' },
    { method: 'GET', path: '/assets/*' },
    { method: 'GET', path: '/assets/css/*' },
    { method: 'GET', path: '/a/*/c' },
    { method: 'GET', path: '/*/b/c' },
    { method: 'POST', path: '/api/users' },
  ]);
  // 遮蔽：0->1、0->2、1->2、3->4
  assert.strictEqual(res.summary.shadow, 4);
  // 部分重叠：5(/a/*/c) 与 6(/*/b/c) 等
  const overlap56 = res.conflicts.find(
    (c) => c.type === 'partial' && c.higher.index === 5 && c.lower.index === 6
  );
  assert.ok(overlap56, '应检出 /a/*/c 与 /*/b/c 的部分重叠');
  assert.strictEqual(overlap56.example, 'GET /a/b/c');
});

console.log(`\n全部 ${passed} 个测试通过。`);
