'use strict';
const { fixture, assert } = require('./tree_fixture');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`),
  pick = (n) => '~pick:' + encodeURIComponent(n);
let checks = 0;
function test(name, f) {
  f();
  console.log('ok ' + name);
  checks++;
}
function simple(names, rows, count = 1) {
  const { T, X } = fixture({ names, rows, count });
  return { T, X, add: (n, p = 'Compile') => T.add([pick(n)], p)[0], ms: (id) => T.msOf(id)[0] };
}
function malloc() {
  return simple(
    ['Compile', 'Work', 'malloc', 'Elsewhere'],
    [0, -1, 0, 130000, 0, 1, 0, 0, 100000, 0, 2, 1, 10000, 10000, 0, 3, 0, 100000, 30000, 0, 2, 3, 100000, 20000, 0],
  );
}
test('fresh layout contains only the expanded unit', () => {
  const { T, X } = fixture();
  assert.equal(T.state().main.open, true);
  assert.equal(T.state().main.children.length, 0);
  assert.equal(X.data.columns.length, 0);
  near(T.msOf('Compile')[0], 100);
  T.check();
});
test('higher extraction, hidden participation and delete restore scoped shares', () => {
  const { T, add, ms } = malloc(),
    work = add('Work'),
    inner = add('malloc'),
    g = T.merge([work, inner], 'Local');
  near(ms(inner), 10);
  near(ms(work), 90);
  near(ms(g), 100);
  const outer = add('malloc');
  near(ms(outer), 30);
  near(ms(inner), 0);
  near(ms(g), 90);
  T.hide(outer);
  near(ms(inner), 0);
  near(ms(g), 90);
  assert.equal(T.blockedBy(inner), outer);
  T.remove([outer]);
  near(ms(inner), 10);
  near(ms(work), 90);
  near(ms(g), 100);
  T.remove([work]);
  near(ms(g), 30);
  near(ms(inner), 30);
  T.check();
});
test('recursive occurrences re-enter the upper selector', () => {
  const { T, add, ms } = simple(
    ['Compile', 'A', 'B'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 100000, 0, 2, 1, 20000, 60000, 0, 1, 2, 40000, 20000, 0],
  );
  const a = add('A'),
    b = add('B', a),
    inner = add('A', b);
  near(ms(a), 100);
  near(ms(b), 40);
  near(ms(inner), 0);
  near(ms('~rest:' + a), 60);
  T.transfer(b, 'Compile');
  near(ms(a), 60);
  near(ms(b), 40);
  near(ms(inner), 0);
  T.check();
});
test('aliases, order, collapse and hide do not alter computation', () => {
  const { T, add, ms } = malloc(),
    a = add('Work'),
    b = add('malloc'),
    before = [ms(a), ms(b)];
  T.rename(a, 'ZZZ');
  T.move(b, a, false);
  T.expand(a);
  T.hide(a);
  T.collapse(b);
  assert.deepEqual([ms(a), ms(b)], before);
  T.check();
});
test('projections are independent and moving re-evaluates current scope', () => {
  const { T, add, ms } = malloc(),
    a = add('Work'),
    b = add('malloc'),
    p = T.copyOver(a);
  near(ms(a), 90);
  near(ms(p), 100);
  T.hide(b);
  near(ms(p), 100);
  T.remove([a]);
  T.transfer(p, 'Compile');
  near(ms(p), 90);
  T.check();
});
test('Rest is a diagnostic of all children and never an input', () => {
  const { T, add, ms } = malloc(),
    a = add('Work'),
    b = add('malloc', a),
    rest = '~rest:' + a;
  near(ms(rest), 90);
  T.add([rest], a);
  T.hide(b);
  near(ms(rest), 90);
  T.hide(rest);
  near(ms(a), 100);
  T.remove([b]);
  near(ms(rest), 100);
  T.check();
});
test('fixed uncovered source is independent of exploration and async work', () => {
  const { T, add, ms } = simple(
    ['Compile', 'A', 'Job'],
    [0, -1, 0, 100000, 0, 1, 0, 10000, 20000, 0, 2, 0, 50000, 20000, 1],
  );
  const gap = add('@uncovered');
  near(ms(gap), 60);
  const a = add('A');
  near(ms(gap), 60);
  T.remove([a]);
  near(ms(gap), 60);
  T.check();
});
test('independent work retains tails in projections', () => {
  const { T, add, ms } = simple(
    ['Compile', 'Job', 'Decode'],
    [0, -1, 0, 100000, 0, 1, 0, 50000, 100000, 1, 2, 1, 60000, 10000, 0],
  );
  assert.ok(!T.candidates('Compile').some((n) => n.label === 'Job'));
  const job = add('Job', '~two'),
    decode = add('Decode', job);
  near(ms(job), 100);
  near(ms(decode), 10);
  T.check();
});
test('deleting expanded groups promotes bases and discards local refiners', () => {
  const { T, add, ms } = malloc(),
    a = add('Work'),
    b = add('malloc'),
    g = T.merge([a, b], 'Local');
  T.remove([g]);
  assert.equal(T.state().main.children.length, 1);
  assert.equal(T.state().main.children[0].id, a);
  near(ms(a), 100);
  assert.equal(ms(b), 0);
  T.check();
});
test('deleting a closed group deletes its exploration', () => {
  const { T, add } = malloc(),
    a = add('Work'),
    b = add('malloc'),
    g = T.merge([a, b], 'Local');
  T.collapse(g);
  T.remove([g]);
  assert.equal(T.state().main.children.length, 0);
  T.check();
});
test('numeric state is independent of edit history and identifiers', () => {
  const first = malloc(),
    second = malloc(),
    a = first.add('Work'),
    m = first.add('malloc'),
    g = first.T.merge([a, m], 'Local');
  second.add('Elsewhere');
  second.T.fresh();
  const b = second.add('Work'),
    h = second.T.merge([b], 'Local'),
    n = second.add('malloc', h);
  near(first.ms(g), second.ms(h));
  near(first.ms(a), second.ms(b));
  near(first.ms(m), second.ms(n));
});
test('unselected instrumentation in an overlapping call cannot change attribution', () => {
  const base = simple(['Compile', 'A', 'B', 'C'], [0, -1, 0, 100000, 0, 1, 0, 0, 80000, 0, 2, 0, 10000, 80000, 0]);
  const extra = simple(
    ['Compile', 'A', 'B', 'C'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 80000, 0, 2, 0, 10000, 80000, 0, 3, 2, 20000, 40000, 0],
  );
  const a = base.add('A'),
    b = extra.add('A');
  near(base.ms(a), 80);
  near(extra.ms(b), 80);
  base.T.check();
  extra.T.check();
});
test('overlapping siblings use deterministic recorded occurrence priority', () => {
  const { T, add, ms } = simple(['Compile', 'A', 'B'], [0, -1, 0, 100000, 0, 1, 0, 0, 60000, 0, 2, 0, 40000, 40000, 0]);
  const a = add('A'),
    b = add('B');
  near(ms(a), 40);
  near(ms(b), 40);
  T.move(a, b, true);
  near(ms(a), 40);
  near(ms(b), 40);
  T.check();
});
test('overlapping duplicate scopes reject atomically', () => {
  const { T, add } = malloc(),
    a = add('Work'),
    b = add('malloc'),
    g = T.merge([a], 'A'),
    before = JSON.stringify(T.state());
  assert.throws(() => T.add([pick('Work')], T.merge([b], 'B')), /selected twice/);
  // The separate group creation is successful; only the conflicting add is rolled back.
  T.check();
  assert.equal(T.state().main.children.length, 2);
});
test('previews match the added selector and deduplicate names', () => {
  const { T, add, ms } = malloc();
  const rows = T.candidates('Compile');
  assert.equal(rows.filter((r) => r.label === 'malloc').length, 1);
  for (const row of rows) {
    const before = T.state(),
      id = T.add([row.id], 'Compile')[0];
    near(row.share, ms(id) / 130);
    T.load(before);
  }
});
test('display undo and redo preserve exact snapshots', () => {
  const { T, add } = malloc(),
    a = add('Work'),
    before = JSON.stringify(T.state());
  T.hide(a);
  const after = JSON.stringify(T.state());
  T.undo();
  assert.equal(JSON.stringify(T.state()), before);
  T.redo();
  assert.equal(JSON.stringify(T.state()), after);
  T.check();
});

test('fuzz: every edit conserves time, survives roundtrip and undoes exactly', () => {
  for (let seed = 1; seed <= Number(process.env.FUZZ_SEEDS || 50); seed++) {
    const { T, add } = malloc();
    let random = seed;
    const rand = (k) => {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return (random >>> 8) % k;
    };
    for (let step = 0; step < 150; step++) {
      const state = T.state(),
        nodes = [];
      const visit = (n) => {
        nodes.push(n);
        n.children.forEach(visit);
      };
      visit(state.main);
      state.projections.forEach(visit);
      const n = nodes[rand(nodes.length)],
        id = n.id,
        op = rand(14),
        before = JSON.stringify(state);
      try {
        if (op === 0) add(['Work', 'malloc', 'Elsewhere'][rand(3)], rand(8) === 0 ? '~two' : id);
        else if (op === 1) T.hide(id);
        else if (op === 2) T.add([id]);
        else if (op === 3) T.expand(id);
        else if (op === 4) T.collapse(id);
        else if (op === 5) T.remove([id]);
        else if (op === 6) T.clearChildren(id);
        else if (op === 7) {
          const ds = T.destinations(id);
          if (ds.length) T.transfer(id, ds[rand(ds.length)].id);
        } else if (op === 8) {
          const choices = nodes.filter((c) => T.canMerge(id, c.id));
          if (choices.length) T.merge([id, choices[rand(choices.length)].id], 'Group');
        } else if (op === 9 && nodes.length < 40) T.copyOver(id);
        else if (op === 10) T.rename(id, 'Label ' + step);
        else if (op === 11) T.add(T.restsOf(id), id);
        else if (op === 12) T.load(state);
        else if (op === 13 && n.group) T.ungroup(id);
      } catch (error) {
        assert.match(error.message, /selected twice|already at|outside this subtree/);
        assert.equal(JSON.stringify(T.state()), before, `non-atomic reject ${seed}/${step}`);
      }
      try {
        T.check();
      } catch (error) {
        console.error('fuzz', seed, step, op, id, JSON.stringify(T.state()));
        throw error;
      }
      if (step % 25 === 0) {
        const cold = malloc().T;
        cold.load(T.state());
        const current = [];
        const visit = (n) => {
          current.push(n.id);
          n.children.forEach(visit);
        };
        visit(T.state().main);
        T.state().projections.forEach(visit);
        for (const id of current) near(T.msOf(id)[0], cold.msOf(id)[0]);
      }
      const after = JSON.stringify(T.state());
      if (before !== after) {
        T.undo();
        assert.equal(JSON.stringify(T.state()), before, `undo ${seed}/${step}`);
        T.check();
        T.redo();
        assert.equal(JSON.stringify(T.state()), after, `redo ${seed}/${step}`);
        T.check();
      }
    }
  }
});

test('name cycles spanning distinct calls form one recursive component', () => {
  const { T, add, ms } = simple(
    ['Compile', 'A', 'B', 'C'],
    [
      0, -1, 0, 90000, 0, 1, 0, 0, 30000, 0, 2, 1, 10000, 10000, 0, 2, 0, 30000, 30000, 0, 3, 3, 40000, 10000, 0, 3, 0,
      60000, 30000, 0, 1, 5, 70000, 10000, 0,
    ],
  );
  const g = T.merge([add('A'), add('B'), add('C')], 'Cycle');
  near(ms(g), 90);
  T.check();
});
test('projection children cannot borrow another occurrence of their parent', () => {
  const { T, add, ms } = simple(
    ['Compile', 'A', 'B'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 20000, 0, 2, 1, 10000, 40000, 0, 1, 0, 40000, 20000, 0],
  );
  const a = add('A', '~two'),
    b = add('B', a);
  near(ms(a), 40);
  near(ms(b), 10);
  T.check();
});
test('dissolving projections retains other independent same-name projections', () => {
  const { T, add } = malloc(),
    a = add('Work', '~two'),
    b = add('malloc', a),
    c = add('Elsewhere', '~two'),
    g = T.merge([a, c], 'Both'),
    copy = T.copyOver(a);
  T.remove([g]);
  assert.ok(T.state().projections.some((n) => n.id === a));
  assert.ok(T.state().projections.some((n) => n.id === copy));
  assert.ok(T.configuredChildren(a).includes(b));
  T.check();
});
test('a group can add a broader base from its containing scope', () => {
  const { T, add, ms } = malloc(),
    m = add('malloc'),
    g = T.merge([m], 'Local'),
    candidate = T.candidates(g).find((r) => r.label === 'Work');
  assert.ok(candidate);
  const w = T.add([candidate.id], g)[0];
  near(ms(g), 100);
  near(ms(w), 90);
  near(ms(m), 10);
  near(candidate.share, 0.9);
  T.check();
});
test('deleted identities cannot pass their factors to new violins', () => {
  const { T, X } = fixture(),
    a = T.add([pick('Prepare')])[0];
  T.setFactor(a, 0.5);
  T.remove([a]);
  const b = T.add([pick('Optimize')])[0];
  assert.equal(X.S.factors.has(b), false);
  T.undo();
  T.undo();
  assert.equal(X.S.factors.get(a), 0.5);
  T.check();
});
test('independent projections retain full duration under a main latency scenario', () => {
  const { T, X, add } = simple(
    ['Compile', 'A', 'Job'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 100000, 0, 2, 0, 50000, 100000, 1],
  );
  const a = add('A'),
    j = add('Job', '~two');
  T.setFactor(a, 0.5);
  const p = T.project(X.S.factors),
    k = X.data.columns.findIndex((c) => c.id === j);
  near(p.total[0], 50);
  near(p.col[k], 100);
  T.check();
});
test('unknown destinations reject without losing a subtree', () => {
  const { T, add } = malloc(),
    a = add('Work'),
    before = JSON.stringify(T.state());
  assert.throws(() => T.transfer(a, 'missing'), /Unknown destination/);
  assert.equal(JSON.stringify(T.state()), before);
});
test('scenario parts retain the displayed Rest bucket', () => {
  const { T, X, add } = malloc(),
    a = add('Work'),
    m = add('malloc', a),
    rest = '~rest:' + a;
  T.add([rest], a);
  T.setFactor(a, 0.5);
  const p = T.project(X.S.factors),
    k = X.data.columns.findIndex((c) => c.id === rest);
  near(p.own[k], 45 / 130);
  near(p.own[X.data.columns.findIndex((c) => c.id === a)], 0);
});
test('mixed projections preserve independent coverage and scenario group sums', () => {
  const { T, X, add } = simple(
    ['Compile', 'A', 'Job'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 100000, 0, 2, 0, 50000, 100000, 1],
  );
  const a = add('A'),
    p = add('A', '~two'),
    j = add('Job', '~two'),
    g = T.merge([p, j], 'Both');
  T.setFactor(a, 0.5);
  const scenario = T.project(X.S.factors),
    value = (id) => scenario.col[X.data.columns.findIndex((c) => c.id === id)];
  near(value(g), 125);
  near(value(p), 25);
  near(value(j), 100);
  T.check();
});
test('hiding a closed intermediate node lifts its children and preserves its collapse state', () => {
  const { T, add } = malloc(),
    a = add('Work'),
    b = add('malloc', a);
  T.collapse(a);
  T.hide(a);
  assert.ok(T.shown(b));
  assert.equal(T.open(a), false);
  T.unskip(a);
  assert.equal(T.shown(b), false);
  T.check();
});
test('matching occurrence counts refresh even when allocated intervals are identical', () => {
  const { T, X, add } = simple(
    ['Compile', 'A', 'B'],
    [0, -1, 0, 100000, 0, 1, 0, 0, 100000, 0, 2, 0, 0, 50000, 0, 2, 0, 50000, 50000, 0],
  );
  const id = add('A');
  assert.equal(X.data.units[0].c[0], 1);
  const state = T.state();
  state.main.children[0].span = 'B';
  T.load(state);
  assert.equal(X.data.units[0].c[0], 2);
  T.check();
});
test('generated recursive and overlapping traces agree with cold recomputation', () => {
  for (let seed = 1; seed <= 50; seed++) {
    let random = seed;
    const rand = (n) => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) >>> 8) % n;
    const names = ['Compile', ...Array.from({ length: 8 }, (_, i) => 'Function ' + i)];
    const rows = [0, -1, 0, 100000, 0];
    for (let r = 1; r < 65; r++)
      rows.push(1 + rand(8), rand(r), rand(110) * 1000, (1 + rand(45)) * 1000, rand(5) === 0 ? 1 : 0);
    const current = simple(names, rows),
      T = current.T;
    for (const name of names.slice(1)) current.add(name);
    T.addGroup(names.slice(1).map(pick), '~two', 'All functions');
    for (let step = 0; step < 20; step++) {
      const nodes = [],
        visit = (n) => {
          nodes.push(n);
          n.children.forEach(visit);
        };
      visit(T.state().main);
      T.state().projections.forEach(visit);
      const id = nodes[rand(nodes.length)].id;
      try {
        const choices = T.destinations(id);
        if (choices.length) T.transfer(id, choices[rand(choices.length)].id);
        if (step % 3 === 0) T.hide(id);
      } catch (error) {
        assert.match(error.message, /selected twice|already at|Independent work/);
      }
      T.check();
      const cold = simple(names, rows).T;
      cold.load(T.state());
      cold.check();
      for (const n of nodes) near(T.msOf(n.id)[0], cold.msOf(n.id)[0]);
    }
  }
});
console.log(`${checks} model checks passed`);
