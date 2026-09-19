'use strict';

/*
 * 路由冲突分析引擎（纯函数，Node 与浏览器均可使用）
 *
 * 规则路径由若干“段”组成：
 *   - 静态段：字面匹配单个非空段
 *   - :参数  ：匹配任意一个非空段
 *   - *     ：匹配零个或多个任意段
 *
 * 每条路径模式被建模成一个带 ε 边的 NFA：
 *   静态段 / :参数  -> 消耗一个段的普通边
 *   *              -> ε 边（匹配零段）+ 消耗一个任意段且仍停留在 * 的自环 + ε 边到下一位置
 *
 * 对两个模式做“乘积 DFA”（子集构造，状态用 BigInt 位掩码），
 * 从而判定：
 *   - 完全遮蔽：L(A) ⊇ L(B)
 *   - 部分重叠：L(A) ∩ L(B) ≠ ∅
 * 并在两个模式的乘积自动机上按“段数最少、并列时字典序最小”搜索
 * 同时命中的具体示例路径。
 *
 * 具体段取值约定：自由段（参数或通配符产生的段）固定使用 "a"，
 * 这是约定的最小自由段值，因此最短并列时得到确定的字典序最小答案。
 */

const OTHER = '__OTHER__';
const FREE_VALUE = 'a'; // 自由段的最小值约定
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** 解析路径字符串为段 token 数组。根路径 "/" -> [] */
function parsePath(path) {
  if (typeof path !== 'string') {
    return { error: '路径必须是字符串', tokens: null };
  }
  if (path.length === 0 || path[0] !== '/') {
    return { error: '路径必须以 / 开头', tokens: null };
  }
  if (path === '/') return { tokens: [] };
  if (path.length > 1 && path[path.length - 1] === '/') {
    return { error: '路径不能以 / 结尾（根路径除外）', tokens: null };
  }
  const segments = path.split('/').slice(1);
  const tokens = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length === 0) {
      return { error: `第 ${i + 1} 段为空（不允许连续的 /）`, tokens: null };
    }
    if (seg === '*') {
      tokens.push({ type: 'wildcard', raw: seg });
    } else if (seg[0] === ':') {
      const name = seg.slice(1);
      if (name.length === 0) {
        return { error: `第 ${i + 1} 段的参数名不能为空`, tokens: null };
      }
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        return {
          error: `第 ${i + 1} 段参数名 :${name} 非法（仅允许字母、数字、下划线）`,
          tokens: null,
        };
      }
      tokens.push({ type: 'param', name, raw: seg });
    } else {
      if (seg.indexOf('*') !== -1) {
        return { error: `第 ${i + 1} 段 "${seg}" 中的 * 必须独占整段`, tokens: null };
      }
      tokens.push({ type: 'literal', value: seg, raw: seg });
    }
  }
  return { tokens };
}

/** ε-闭包：从一组 NFA 位置（BigInt 位掩码）出发，沿 ε 边可达的全部位置 */
function epsilonClosure(tokens, mask) {
  const n = tokens.length;
  let changed = true;
  // * 位于位置 i 时：i --ε--> i+1（通配符匹配零段），
  // 且消耗一个段的自环 i->i 由 step 处理。闭包按位置从小到大传播即可达到不动点。
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (tokens[i].type === 'wildcard') {
        const bit = 1n << BigInt(i);
        const next = 1n << BigInt(i + 1);
        if ((mask & bit) !== 0n && (mask & next) === 0n) {
          mask |= next;
          changed = true;
        }
      }
    }
  }
  return mask;
}

/** 一个 DFA 状态（NFA 位置集合）在消耗一个具体段后的转移 */
function subsetStep(tokens, mask, letter) {
  const n = tokens.length;
  let next = 0n;
  for (let i = 0; i <= n; i++) {
    if ((mask & (1n << BigInt(i))) === 0n) continue;
    if (i < n) {
      const t = tokens[i];
      if (t.type === 'literal') {
        if (letter === t.value) next |= 1n << BigInt(i + 1);
      } else if (t.type === 'param') {
        next |= 1n << BigInt(i + 1);
      } else {
        // * 的消耗自环：吃掉一个任意段后仍停留在位置 i
        next |= 1n << BigInt(i);
      }
    }
  }
  return next === 0n ? 0n : epsilonClosure(tokens, next);
}

/**
 * 构造模式的惰性 DFA。
 *   step(mask, letter)：带缓存的子集转移
 *   accepts(mask)     ：集合中是否含接受位置 n
 *   start             ：起始状态（ε-闭包({0})）
 */
function buildDFA(tokens) {
  const n = tokens.length;
  const acceptBit = 1n << BigInt(n);
  const start = epsilonClosure(tokens, 1n);
  const cache = new Map();

  function step(mask, letter) {
    let byLetter = cache.get(mask);
    if (!byLetter) {
      byLetter = new Map();
      cache.set(mask, byLetter);
    }
    let res = byLetter.get(letter);
    if (res === undefined) {
      res = subsetStep(tokens, mask, letter);
      byLetter.set(letter, res);
    }
    return res;
  }

  return {
    tokens,
    n,
    start,
    step,
    accepts: (mask) => (mask & acceptBit) !== 0n,
  };
}

/** 收集模式中出现的所有静态字面量 */
function literalsOf(tokens) {
  const set = new Set();
  for (const t of tokens) {
    if (t.type === 'literal') set.add(t.value);
  }
  return set;
}

/**
 * 判定 L(A) 是否覆盖 L(B)（即 A 是否遮蔽 B）。
 * 对两个 DFA 做乘积可达性搜索：
 * 若存在可达状态 (a, b) 满足 B 接受而 A 不接受，则不覆盖。
 * 字母表 = 两个模式的全部字面量 + OTHER（代表任何其他段值）。
 */
function covers(dfaA, dfaB) {
  const alphabet = new Set([OTHER]);
  for (const v of literalsOf(dfaA.tokens)) alphabet.add(v);
  for (const v of literalsOf(dfaB.tokens)) alphabet.add(v);
  const letters = [...alphabet];

  const seen = new Set();
  const stack = [[dfaA.start, dfaB.start]];
  while (stack.length) {
    const [ma, mb] = stack.pop();
    const key = `${ma.toString(16)}|${mb.toString(16)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (dfaB.accepts(mb) && !dfaA.accepts(ma)) return false;

    for (const letter of letters) {
      const na = letter === OTHER ? stepOther(dfaA, ma) : dfaA.step(ma, letter);
      const nb = letter === OTHER ? stepOther(dfaB, mb) : dfaB.step(mb, letter);
      if (nb === 0n) continue; // B 不接受该段 -> 此路不在 L(B) 中
      stack.push([na, nb]);
    }
  }
  return true;
}

/** OTHER 字母的转移：把字母当作不匹配任何字面量的段 */
function stepOther(dfa, mask) {
  const n = dfa.n;
  let next = 0n;
  for (let i = 0; i <= n; i++) {
    if ((mask & (1n << BigInt(i))) === 0n) continue;
    if (i < n) {
      const t = dfa.tokens[i];
      if (t.type === 'literal') continue;
      next |= 1n << BigInt(t.type === 'param' ? i + 1 : i);
    }
  }
  return next === 0n ? 0n : epsilonClosure(dfa.tokens, next);
}

/**
 * 在 L(A) ∩ L(B) 中搜索“段数最少、并列字典序最小”的段序列。
 * 乘积 DFA 上按长度做 BFS；同一层的边按字母升序处理，
 * 每个乘积状态仅保留第一条到达路径，因此首个到达的接受状态即答案。
 */
function shortestIntersectionWord(dfaA, dfaB) {
  const alphabet = new Set([FREE_VALUE]);
  for (const v of literalsOf(dfaA.tokens)) alphabet.add(v);
  for (const v of literalsOf(dfaB.tokens)) alphabet.add(v);
  // 字典序：UTF-16 码元升序（即 JavaScript 原生字符串比较）
  const letters = [...alphabet].sort();

  const seen = new Set();
  let frontier = [{ a: dfaA.start, b: dfaB.start, word: '' }];

  for (let depth = 0; frontier.length; depth++) {
    // 同层按已有单词字典序处理，保证同深度下先访问字典序更小的状态
    frontier.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
    const nextFrontier = [];
    for (const state of frontier) {
      const key = `${state.a.toString(16)}|${state.b.toString(16)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (dfaA.accepts(state.a) && dfaB.accepts(state.b)) {
        return depth === 0 ? '/' : state.word;
      }

      for (const letter of letters) {
        const na = dfaA.step(state.a, letter);
        const nb = dfaB.step(state.b, letter);
        if (na === 0n || nb === 0n) continue;
        const nk = `${na.toString(16)}|${nb.toString(16)}`;
        if (seen.has(nk)) continue;
        nextFrontier.push({
          a: na,
          b: nb,
          word: state.word === '' ? `/${letter}` : `${state.word}/${letter}`,
        });
      }
    }
    // 同层可能经不同单词到达同一状态：去重，保留字典序最小的单词
    const byKey = new Map();
    for (const st of nextFrontier) {
      const k = `${st.a.toString(16)}|${st.b.toString(16)}`;
      const prev = byKey.get(k);
      if (!prev || st.word < prev.word) byKey.set(k, st);
    }
    frontier = [...byKey.values()];
  }
  return null;
}

/** 规范化请求方法；非法时返回 null */
function normalizeMethod(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toUpperCase();
  if (m === 'ALL' || m === '*') return 'ALL';
  if (METHODS.includes(m)) return m;
  return null;
}

/**
 * 分析规则集。
 * 入参：[{ id?, method, path }]，数组顺序即优先级（索引 0 最先匹配）。
 * 返回：{ valid, rules:[...逐条结果], conflicts:[...], summary:{...} }
 */
function analyze(rawRules, opts) {
  const computeFixPlan = !opts || opts.computeFixPlan !== false;
  const rules = Array.isArray(rawRules) ? rawRules : [];
  const compiled = [];
  let validCount = 0;

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] || {};
    const method = normalizeMethod(r.method);
    const parsed = parsePath(r.path);
    const errors = [];
    if (!method) errors.push('请求方法非法');
    if (parsed.error) errors.push(parsed.error);

    const ok = errors.length === 0;
    compiled.push({
      index: i,
      id: r.id ?? i,
      methodRaw: typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      method: ok ? method : null,
      path: typeof r.path === 'string' ? r.path : '',
      tokens: ok ? parsed.tokens : null,
      dfa: ok ? buildDFA(parsed.tokens) : null,
      valid: ok,
      errors,
      shadows: [],
      overlaps: [],
    });
    if (ok) validCount++;
  }

  const conflicts = [];
  // 所有“方法兼容的有效规则对”及其双向覆盖关系，供修复方案构建约束图
  const pairRelations = [];

  for (let i = 0; i < compiled.length; i++) {
    for (let j = i + 1; j < compiled.length; j++) {
      const hi = compiled[i];
      const lo = compiled[j];
      if (!hi.valid || !lo.valid) continue;

      // 仅相同方法、或任一方为 ALL 时才可能冲突
      if (hi.method !== 'ALL' && lo.method !== 'ALL' && hi.method !== lo.method) continue;

      const coversHL = covers(hi.dfa, lo.dfa);
      const coversLH = covers(lo.dfa, hi.dfa);
      pairRelations.push({ i, j, coversIJ: coversHL, coversJI: coversLH });

      let type;
      if (coversHL) {
        type = 'shadow'; // 高优先级规则完全遮蔽低优先级
      } else {
        if (shortestIntersectionWord(hi.dfa, lo.dfa) === null) continue; // 交集为空
        type = 'partial';
      }

      // 同时命中的最短示例路径（并列时字典序最小）
      const example = shortestIntersectionWord(hi.dfa, lo.dfa);

      // 示例路径使用的方法：优先具体方法；含 ALL 时取另一方的具体方法
      const exampleMethod =
        hi.method !== 'ALL' ? hi.method : lo.method !== 'ALL' ? lo.method : 'GET';

      conflicts.push({
        type, // 'shadow' 完全遮蔽 | 'partial' 部分重叠
        higher: { index: hi.index, id: hi.id, method: hi.methodRaw, path: hi.path },
        lower: { index: lo.index, id: lo.id, method: lo.methodRaw, path: lo.path },
        method: exampleMethod,
        examplePath: example,
        example: `${exampleMethod} ${example}`,
      });
    }
  }

  // 逐条规则标注与之冲突的其他规则索引
  for (const r of compiled) {
    r.shadows = [];
    r.overlaps = [];
  }
  for (const c of conflicts) {
    const hi = compiled[c.higher.index];
    const lo = compiled[c.lower.index];
    if (c.type === 'shadow') {
      hi.shadows.push(lo.index);
      lo.overlaps.push(hi.index);
    } else {
      hi.overlaps.push(lo.index);
      lo.overlaps.push(hi.index);
    }
  }

  const ruleResults = compiled.map((r) => ({
    index: r.index,
    id: r.id,
    method: r.methodRaw,
    path: r.path,
    valid: r.valid,
    errors: r.errors,
    shadows: r.shadows,
    overlaps: r.overlaps,
  }));

  const shadowCount = conflicts.filter((c) => c.type === 'shadow').length;
  const partialCount = conflicts.length - shadowCount;
  const signature = rawRulesSignature(rules);

  if (!computeFixPlan) {
    return {
      valid: compiled.every((r) => r.valid),
      total: rules.length,
      validCount,
      rules: ruleResults,
      conflicts,
      signature,
      summary: {
        shadow: shadowCount,
        partial: partialCount,
        total: conflicts.length,
      },
    };
  }

  const fixPlan = buildFixPlan(compiled, rules, pairRelations, shadowCount, partialCount);

  return {
    valid: compiled.every((r) => r.valid),
    total: rules.length,
    validCount,
    rules: ruleResults,
    conflicts,
    signature,
    summary: {
      shadow: shadowCount,
      partial: partialCount,
      total: conflicts.length,
    },
    fixPlan,
  };
}

/** 规则集内容签名：顺序 + 方法 + 路径，供前端判断预览的方案是否已过期 */
function rawRulesSignature(rawRules) {
  return JSON.stringify(
    (Array.isArray(rawRules) ? rawRules : []).map((r) => [
      r && typeof r.method === 'string' ? r.method.trim().toUpperCase() : '',
      r && typeof r.path === 'string' ? r.path : '',
    ])
  );
}

/**
 * 生成确定性的重排修复方案。
 *
 * 思路：
 *   1. 按“路径语言等价”（covers 双向成立）且方法兼容的关系，用并查集把规则
 *      合并为语言等价组（language equivalence class）；
 *   2. 对所有“i 的路径被 j 的路径严格覆盖”（covers(i,j) 且 !covers(j,i)）的
 *      规则对，在组与组之间添加有向边 group(i) -> group(j)，得到约束图：
 *      即“更具体的规则必须排在严格覆盖它的规则之前”；
 *   3. 约束图是严格偏序，天然无环；对其做确定性拓扑排序（Kahn，
 *      并列时按组内最小的原始索引升序），组内保持原始相对顺序；
 *   4. 组内路径语言互相覆盖、方法又兼容的规则对，无论怎么排序都存在遮蔽，
 *      显式标记为 unavoidable（不可通过排序消除），绝不伪装成已修复；
 *   5. 按建议顺序重排后再次运行 analyze，得到应用后仍不可避免的真实遮蔽数。
 */
function buildFixPlan(compiled, rawRules, pairRelations, shadowCount, partialCount) {
  const n = compiled.length;
  const validFlags = compiled.map((r) => r.valid);

  /* --- 1. 并查集：路径语言等价且方法兼容的规则合并 --- */
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const p of pairRelations) {
    if (p.coversIJ && p.coversJI) union(p.i, p.j);
  }

  const memberMap = new Map();
  for (let i = 0; i < n; i++) {
    if (!validFlags[i]) continue; // 无效规则不参与等价组
    const root = find(i);
    if (!memberMap.has(root)) memberMap.set(root, []);
    memberMap.get(root).push(i);
  }
  // 组内保持原始顺序
  const groups = [...memberMap.values()].map((members) => members.sort((a, b) => a - b));
  groups.sort((a, b) => a[0] - b[0]); // 组顺序确定：按组内最小原始索引

  const groupIdOf = new Array(n).fill(-1);
  groups.forEach((members, gi) => {
    for (const m of members) groupIdOf[m] = gi;
  });

  /* --- 2. 构建组间约束图（严格覆盖：更具体 -> 更宽泛） --- */
  const G = groups.length;
  const adj = Array.from({ length: G }, () => new Set());
  const indeg = new Array(G).fill(0);
  const edgeKeys = new Set();
  for (const p of pairRelations) {
    // covers(i,j) 为真表示 L(i) ⊇ L(j)：i 更宽泛、j 更具体
    const iWider = p.coversIJ && !p.coversJI; // j 的路径被 i 严格覆盖
    const jWider = p.coversJI && !p.coversIJ; // i 的路径被 j 严格覆盖
    if (!iWider && !jWider) continue;
    const narrower = iWider ? p.j : p.i; // 路径更具体
    const wider = iWider ? p.i : p.j; // 严格覆盖 narrower
    const ga = groupIdOf[narrower];
    const gb = groupIdOf[wider];
    if (ga === gb || ga < 0 || gb < 0) continue;
    const key = `${ga}>${gb}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    adj[ga].add(gb);
    indeg[gb]++;
  }

  /* --- 3. 确定性拓扑排序：Kahn，并列按组内最小原始索引（=groups 的顺序） --- */
  const queue = [];
  for (let g = 0; g < G; g++) if (indeg[g] === 0) queue.push(g);
  const sortedGroups = [];
  while (queue.length) {
    queue.sort((a, b) => groups[a][0] - groups[b][0]);
    const g = queue.shift();
    sortedGroups.push(g);
    for (const w of adj[g]) {
      indeg[w]--;
      if (indeg[w] === 0) queue.push(w);
    }
  }
  // 严格覆盖是严格偏序，约束图必无环；万一出现环则保守判定为不可自动修复
  const feasible = sortedGroups.length === G;
  if (!feasible) {
    for (let g = 0; g < G; g++) if (!sortedGroups.includes(g)) sortedGroups.push(g);
  }

  /* --- 4. 无效规则作为独立单元，按原始索引与组交错（保持其原有相对位置） --- */
  const units = groups.map((members, gi) => ({ kind: 'group', gi, members, min: members[0] }));
  for (let i = 0; i < n; i++) {
    if (!validFlags[i]) units.push({ kind: 'invalid', members: [i], min: i });
  }
  const groupRank = new Map(sortedGroups.map((gi, pos) => [gi, pos]));
  units.sort((u1, u2) => {
    if (u1.kind === 'group' && u2.kind === 'group') {
      return groupRank.get(u1.gi) - groupRank.get(u2.gi);
    }
    return u1.min - u2.min; // 含无效单元时退化为按原始索引，不扰动其位置
  });
  const order = units.flatMap((u) => u.members);

  const newPosOf = new Array(n).fill(-1);
  order.forEach((origIdx, pos) => {
    newPosOf[origIdx] = pos;
  });

  /* --- 5. 组内互相覆盖且方法兼容的规则对：排序无法消除的遮蔽 --- */
  const unavoidablePairs = [];
  const unavoidableByGroup = new Array(G).fill(0);
  for (const p of pairRelations) {
    if (p.coversIJ && p.coversJI) {
      // 双向覆盖即路径语言等价；并查集保证二者同组、且方法兼容
      const gi = groupIdOf[p.i];
      unavoidableByGroup[gi]++;
      unavoidablePairs.push({
        a: ruleRef(compiled, p.i),
        b: ruleRef(compiled, p.j),
      });
    }
  }
  const unavoidableCount = unavoidablePairs.length;

  /* --- 6. 位置调整明细：1-based 位置，仅列出实际移动的规则 --- */
  const moves = order
    .map((origIdx) => ({
      rule: ruleRef(compiled, origIdx),
      from: origIdx + 1,
      to: newPosOf[origIdx] + 1,
    }))
    .filter((m) => m.from !== m.to)
    .sort((a, b) => a.to - b.to);

  /* --- 7. 约束图边（导出，便于审计） --- */
  const constraints = [];
  for (const p of pairRelations) {
    const iWider = p.coversIJ && !p.coversJI;
    const jWider = p.coversJI && !p.coversIJ;
    if (!iWider && !jWider) continue;
    const narrower = iWider ? p.j : p.i;
    const wider = iWider ? p.i : p.j;
    if (groupIdOf[narrower] === groupIdOf[wider]) continue;
    constraints.push({
      narrower: ruleRef(compiled, narrower),
      wider: ruleRef(compiled, wider),
      reason: '前者路径更具体，必须位于严格覆盖它的后者之前',
    });
  }

  const equivalenceGroups = groups.map((members, gi) => ({
    members: members.map((idx) => ruleRef(compiled, idx)),
    size: members.length,
    unavoidableShadow: unavoidableByGroup[gi],
    resolvableByOrder: unavoidableByGroup[gi] === 0,
  }));

  /* --- 8. 应用建议顺序后重新分析，得到真实的残留遮蔽数（不伪装） --- */
  const reordered = order.map((idx) => rawRules[idx]);
  const after = analyze(reordered, { computeFixPlan: false });
  const residualShadow = after.summary.shadow;
  const residualPartial = after.summary.partial;
  // 残留冲突（用于预览），位置按“应用后”的新顺序标注
  const residualConflicts = after.conflicts.map((c) => ({
    type: c.type,
    higher: ruleRef(compiled, order[c.higher.index]),
    lower: ruleRef(compiled, order[c.lower.index]),
    newPositionA: c.higher.index + 1,
    newPositionB: c.lower.index + 1,
    example: c.example,
  }));

  return {
    needed: shadowCount > 0,
    feasible,
    shadowBefore: shadowCount,
    shadowAfter: residualShadow,
    fixedCount: shadowCount - residualShadow,
    unavoidableShadow: unavoidableCount,
    partialBefore: partialCount,
    partialAfter: residualPartial,
    moves,
    order: order.map((idx) => idx), // 建议顺序：原始索引的排列（0-based）
    constraints,
    equivalenceGroups: equivalenceGroups.filter((g) => g.size > 1),
    unavoidablePairs,
    residualConflicts,
  };
}

function ruleRef(compiled, idx) {
  const r = compiled[idx];
  return { index: r.index, id: r.id, method: r.methodRaw, path: r.path };
}

const api = {
  parsePath,
  buildDFA,
  covers,
  shortestIntersectionWord,
  normalizeMethod,
  analyze,
  METHODS,
  FREE_VALUE,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.RouteAnalyzer = api;
}
