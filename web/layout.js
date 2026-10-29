// The violins as a tree built from the spans themselves. Every call path (a span name under its parent's path) is a
// node: the unit's own span at the root, the spans it calls under it, and so on. The Phases tab shows the root and
// whichever nodes the viewer opened, added or merged; a node's time in a unit is the time its spans cover there,
// overlaps counted once, cut to the unit. A merged node is several nodes as one: its time is theirs together, and it
// sits under the nearest path that holds them all. "Not under any span" is the unit's time that none of the spans it
// calls covers. A second tree, Projections, holds violins that cut across the first and take nothing from it.
//
// From what is shown come the columns every view uses (data.columns, the first tree's then the second's), each unit's
// time in them (u.s, u.f, u.c), each column's own time in its tree, deepest first (u.o), the split of each unit's time
// in the first tree (u.p, data.partition), where the two trees' own times meet (u.x), and which column of the first
// tree each span counts toward.
(function () {
  'use strict';
  const X = window.TX, data = X.data, meta = X.meta;
  const SEP = '\u0001', REST = '~rest';
  // Opening a node shows the children that take at least BIG of its time on average, at most MAX_OPEN of them.
  const BIG = 0.05, MAX_OPEN = 6;

  // ---------------------------------------------------------------------------------------------------------
  // The index: call paths, and in each unit, each path's spans: how many, their summed and self time, and the time
  // they cover as merged intervals in µs from the unit's start.

  const paths = [];
  const pathByKey = new Map();
  const units = new Array(X.NU).fill(null);
  let indexed = 0, rootPath = -1, ready = false;

  function intern(key, name, parent) {
    let id = pathByKey.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push({ id, key, name, parent, depth: parent >= 0 ? paths[parent].depth + 1 : 0, kids: [], n: 0, share: 0, start: 0 });
      pathByKey.set(key, id);
      if (parent >= 0) paths[parent].kids.push(id);
    }
    return id;
  }

  // Merged length of flat intervals [a0, b0, a1, b1, …] within [lo, hi].
  function coveredIn(list, lo, hi) {
    if (!list) return 0;
    const pairs = [];
    for (let k = 0; k < list.length; k += 2) { const a = Math.max(lo, list[k]), b = Math.min(hi, list[k + 1]); if (b > a) pairs.push([a, b]); }
    pairs.sort((x, y) => x[0] - y[0]);
    let len = 0, a = -Infinity, b = -Infinity;
    for (const [x, y] of pairs) {
      if (x > b) { if (b > a) len += b - a; a = x; b = y; } else if (y > b) b = y;
    }
    return len + (b > a ? b - a : 0);
  }

  function indexUnit(i, chunk) {
    const u = data.units[i], tree = chunk.trees[i - u.k * meta.chunk], f = tree.rows, n = f.length / 5, flow = X.traceFlows(tree);
    const L = n ? Math.max(1, f[3]) : 1;
    const rowPath = new Int32Array(n), keyOf = new Array(n), kids = new Array(n);
    for (let r = 0; r < n; r++) {
      const name = chunk.names[f[5 * r]], parent = f[5 * r + 1];
      keyOf[r] = parent >= 0 ? keyOf[parent] + SEP + name : name;
      rowPath[r] = intern(keyOf[r], name, parent >= 0 ? rowPath[parent] : -1);
      const P = paths[rowPath[r]];
      P.main = P.main || !!flow.main[r]; P.independent = !P.main;
      P.flow = P.flow || flow.root[r] > 0; P.dependency = P.dependency || !!flow.dependency[r];
      // A span's self time is its length less what its synchronous children cover.
      if (parent >= 0 && !(f[5 * r + 4] & 1)) (kids[parent] || (kids[parent] = [])).push(f[5 * r + 2], f[5 * r + 2] + f[5 * r + 3]);
    }
    if (n && rootPath < 0) rootPath = rowPath[0];
    const order = Array.from({ length: n }, (_, r) => r).sort((x, y) => rowPath[x] - rowPath[y] || f[5 * x + 2] - f[5 * y + 2]);
    const ids = [], off = [0], a = [], b = [], mainOff = [0], mainA = [], mainB = [], cnt = [], dur = [], self = [], flows = [];
    for (let q = 0; q < n;) {
      const p = rowPath[order[q]], from = a.length, mainFrom = mainA.length;
      let c = 0, d = 0, s = 0, flowCount = 0;
      for (; q < n && rowPath[order[q]] === p; q++) {
        const r = order[q], s0 = f[5 * r + 2], s1 = s0 + f[5 * r + 3];
        if (flow.root[r] > 0) flowCount++;
        c++; d += s1 - s0; s += Math.max(0, s1 - s0 - coveredIn(kids[r], s0, s1));
        if (flow.main[r] && flow.hi[r] > flow.lo[r]) {
          const x = flow.lo[r], y = flow.hi[r];
          if (mainA.length > mainFrom && x <= mainB[mainB.length - 1]) mainB[mainB.length - 1] = Math.max(mainB[mainB.length - 1], y);
          else { mainA.push(x); mainB.push(y); }
        }
        const x0 = flow.root[r] > 0 ? s0 : Math.max(0, s0), x1 = flow.root[r] > 0 ? s1 : Math.min(L, s1);
        if (x1 <= x0) continue;
        if (a.length > from && x0 <= b[b.length - 1]) b[b.length - 1] = Math.max(b[b.length - 1], x1);
        else { a.push(x0); b.push(x1); }
      }
      let len = 0;
      for (let k = from; k < a.length; k++) len += b[k] - a[k];
      const P = paths[p];
      P.n++; P.share += len / L; P.start += a.length > from ? a[from] / L : 1;
      ids.push(p); off.push(a.length); mainOff.push(mainA.length); cnt.push(c); dur.push(d); self.push(s); flows.push(flowCount);
    }
    units[i] = { L, rowPath, ids: Int32Array.from(ids), off: Int32Array.from(off), a: Float64Array.from(a), b: Float64Array.from(b),
      mainOff: Int32Array.from(mainOff), mainA: Float64Array.from(mainA), mainB: Float64Array.from(mainB),
      cnt: Int32Array.from(cnt), dur: Float64Array.from(dur), self: Float64Array.from(self), flows: Int32Array.from(flows) };
    indexed++;
  }

  function indexChunk(k) {
    const chunk = X.chunk(k);
    if (!chunk) return;
    const first = k * meta.chunk, last = Math.min(X.NU, first + meta.chunk);
    for (let i = first; i < last; i++) if (!units[i]) indexUnit(i, chunk);
    if (indexed === X.NU && !ready) start();
  }

  // Where a path's entry is in a unit, or -1.
  function entry(i, p) {
    const ids = units[i].ids;
    let lo = 0, hi = ids.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ids[m] === p) return m; if (ids[m] < p) lo = m + 1; else hi = m - 1; }
    return -1;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Nodes: paths by their key, merged nodes as g1, g2, …, and the rest. A second tree, under its own root (X.ROOT2),
  // holds violins that take nothing from the first: copies of paths (their key after T2), put at its top or merged
  // there, with every path under them; merged nodes of its own; the same span can be in both trees.

  // Shown: the nodes put on screen; one shows while every node above it is open. Open: the nodes opened; closed, a
  // node keeps what was shown under it for when it opens again, and open with none of its children shown, its + adds
  // just the ones wanted. Names: what the viewer called a path, its copy or the rest, when not what its spans are
  // called. Top2: the copies put at the top of the second tree. A merged node can sit inside another (its parent), its
  // spans all inside it.
  // Order: children the viewer put in an order of their own, by parent; the rest follow, in the order they run.
  // Except: spans left out of a node's time, by node. Skip: paths taken out from between their parent and their
  // children, which show under the parent instead.
  const L = { shown: new Set(), groups: new Map(), names: new Map(), top2: new Set(), open: new Set(), order: new Map(), parents: new Map(), except: new Map(), skip: new Set(), next: 1 };
  let memberOf = new Map(), in2 = new Set(), transfers = [];
  let definitionVersion = 0;
  const T2 = '\u0002', ROOT2 = X.ROOT2;

  const isPath = (id) => pathByKey.has(id);
  const isCopy = (id) => typeof id === 'string' && id[0] === T2 && pathByKey.has(id.slice(1));
  const copyOf = (key) => T2 + key;
  // A path or its copy: the path; else -1.
  const pathOf = (id) => (isPath(id) ? pathByKey.get(id) : isCopy(id) ? pathByKey.get(id.slice(1)) : -1);
  const exists = (id) => isPath(id) || isCopy(id) || L.groups.has(id) || id === REST;
  const rootKey = () => paths[rootPath].key;
  const independentOf = (id) => pathOf(id) >= 0 ? !!paths[pathOf(id)].independent : L.groups.has(id) && L.groups.get(id).members.some(independentOf);
  const flowOf = (id) => pathOf(id) >= 0 ? !!paths[pathOf(id)].flow : L.groups.has(id) && L.groups.get(id).members.some(flowOf);
  const dependencyOf = (id) => pathOf(id) >= 0 ? !!paths[pathOf(id)].dependency : L.groups.has(id) && L.groups.get(id).members.some(dependencyOf);
  function structuralInside(id, parent) {
    for (let k = id; k !== null; k = callParent(k)) if (k === parent) return true;
    return false;
  }
  const rawInside = (x, y) => {
    if (x === y) return true;
    if (pathOf(x) < 0 || pathOf(y) < 0) return false;
    for (let p = pathOf(x); p >= 0; p = paths[p].parent) if (p === pathOf(y)) return true;
    return false;
  };
  function excludedBy(id, child) { return (L.except.get(id) || []).some((m) => rawInside(child, m)); }
  function contains(id, child) {
    if (treeOf(id) !== treeOf(child) || (pathOf(id) >= 0 && !independentOf(id) && independentOf(child)) || excludedBy(id, child)) return false;
    if (L.groups.has(id)) return L.groups.get(id).members.some((m) => contains(m, child));
    return rawInside(child, id);
  }
  const isRoot = (id) => id === rootKey() || id === ROOT2;
  const treeOf = (id) => (id === ROOT2 || isCopy(id) || (L.groups.has(id) && L.groups.get(id).tree === 2) ? 2 : 1);
  function spanName(id) {
    const p = pathOf(id);
    if (p >= 0) return paths[p].name;
    if (id === REST) return 'Not under any span';
    return null;
  }
  function label(id) {
    if (L.names.has(id)) return L.names.get(id);
    if (L.groups.has(id)) return L.groups.get(id).label;
    if (id === ROOT2) return 'Projections';
    return spanName(id) || id;
  }

  // The path a node hangs from: a path its own; a merged node the nearest path holding all its members; the rest
  // the root. Its depth in the call tree, for which of two overlapping nodes counts a moment: the deeper.
  function anchor(id) {
    const p = pathOf(id);
    if (p >= 0) return p;
    if (id === REST || id === ROOT2) return rootPath;
    let lca = -1;
    for (const m of L.groups.get(id).members) lca = lca < 0 ? anchor(m) : common(lca, anchor(m));
    return lca < 0 ? rootPath : lca;
  }
  function common(p, q) {
    while (paths[p].depth > paths[q].depth) p = paths[p].parent;
    while (paths[q].depth > paths[p].depth) q = paths[q].parent;
    while (p !== q) { p = paths[p].parent; q = paths[q].parent; }
    return p;
  }
  function callDepth(id) {
    const p = pathOf(id);
    if (p >= 0) return paths[p].depth;
    if (id === REST) return 1;
    return Math.min(...L.groups.get(id).members.map(callDepth));
  }
  // Whether node x lies inside node y, in the same tree: under one of y's paths, or one of its members.
  function inside(x, y) {
    if (x === y) return true;
    if (treeOf(x) !== treeOf(y)) return false;
    if (L.groups.has(y)) return L.groups.get(y).members.some((m) => inside(x, m));
    if (y === REST || x === REST) return false;
    const py = pathOf(y);
    for (let p = anchor(x); p >= 0; p = paths[p].parent) if (p === py) return x !== y;
    return false;
  }

  // Where a node shows: in the merged node it is part of, or under its path's parent, or under its anchor. In the
  // second tree: a copy at its top, or under its parent's copy; a merged node under the copy of its anchor when that is
  // there, else at the top. Null: not in either tree.
  function parentOf(id) {
    const up = callParent(id);
    return up !== null && L.skip.has(up) ? parentOf(up) : up;
  }
  let parentCache = new Map();
  function callParent(id) {
    if (parentCache.has(id)) return parentCache.get(id);
    const p = computeParent(id); parentCache.set(id, p); return p;
  }
  function computeParent(id) {
    if (memberOf.has(id)) return memberOf.get(id);
    if (L.parents.has(id)) return L.parents.get(id);
    if (pathOf(id) >= 0) {
      const P = paths[pathOf(id)];
      if (P.independent && (!paths[P.parent] || !paths[P.parent].independent)) return isCopy(id) ? ROOT2 : null;
      let p = P.parent;
      if (p >= 0 && L.except.size) {
        let up = isCopy(id) ? copyOf(paths[p].key) : paths[p].key;
        // An excluded path is available outside the excluding definition, with its descendants intact.
        let blocked = null;
        for (let q = up; q !== null; q = callParent(q)) if (excludedBy(q, id)) blocked = q;
        if (blocked !== null) {
          let above = callParent(blocked);
          while (above !== null && !isRoot(above) && !contains(above, id)) above = callParent(above);
          return above;
        }
      }
    }
    if (isPath(id)) { const p = paths[pathByKey.get(id)].parent; return p >= 0 ? paths[p].key : null; }
    if (isCopy(id)) {
      if (L.top2.has(id)) return ROOT2;
      const p = paths[pathOf(id)].parent;
      return p >= 0 && in2.has(paths[p].key) ? copyOf(paths[p].key) : null;
    }
    if (id === REST) return rootKey();
    if (!L.groups.has(id)) return null;
    if (L.groups.get(id).parent) return L.groups.get(id).parent;
    const ap = anchor(id), direct = spansOf(id).some((m) => pathOf(m) === ap);
    const a = paths[direct && paths[ap].parent >= 0 ? paths[ap].parent : ap].key;
    if (L.groups.get(id).tree !== 2) return a;
    return in2.has(a) ? copyOf(a) : ROOT2;
  }
  // Every node's children, shown or not; built again whenever what is merged changes.
  let kidsOf = new Map();
  let definitionKey = '';
  function relink() {
    parentCache = new Map();
    const key = JSON.stringify([[...L.groups].map(([g, d]) => [g, d.members, d.tree, d.parent]), [...L.parents], [...L.except], [...L.top2]]);
    if (key !== definitionKey) { definitionKey = key; definitionVersion++; coverageCache.clear(); msCache.clear(); nodeCache.clear(); }
    // Where a span shows: in the deepest merged node it is in.
    memberOf = new Map();
    const level = (g) => { let n = 0; for (let q = L.groups.get(g).parent; q && L.groups.has(q); q = L.groups.get(q).parent) n++; return n; };
    for (const g of [...L.groups.keys()].sort((x, y) => level(x) - level(y))) for (const m of L.groups.get(g).members) memberOf.set(m, g);
    // The paths in the second tree: those put there or merged there, and every path under them.
    in2 = new Set();
    const grow = (p) => { if (in2.has(paths[p].key)) return; in2.add(paths[p].key); for (const q of paths[p].kids) grow(q); };
    for (const id of L.top2) grow(pathOf(id));
    for (const P of paths) if (P.independent && (!paths[P.parent] || !paths[P.parent].independent)) grow(P.id);
    for (const d of L.groups.values()) if (d.tree === 2) for (const m of d.members) if (isCopy(m)) grow(pathOf(m));
    transfers = [...new Set([...memberOf.keys(), ...L.parents.keys(), ...L.top2])];
    kidsOf = new Map();
    const add = (id) => { const p = parentOf(id); if (p !== null) (kidsOf.get(p) || kidsOf.set(p, []).get(p)).push(id); };
    for (const P of paths) if (P.id !== rootPath && !P.independent) add(P.key);
    for (const key of in2) add(copyOf(key));
    for (const g of L.groups.keys()) add(g);
    add(REST);
    for (const [p, list] of kidsOf) {
      const order = L.order.get(p) || [], at = (x) => { const k = order.indexOf(x); return k < 0 ? Infinity : k; };
      list.sort((x, y) => at(x) - at(y) || startOf(x) - startOf(y));
    }
  }
  // When a node usually starts in a unit, as a share of it, so children read in the order they run.
  function startOf(id) {
    const p = pathOf(id);
    if (p >= 0) { const P = paths[p]; return P.n ? P.start / P.n : 1; }
    if (id === REST) return 2;
    return Math.min(...L.groups.get(id).members.map(startOf));
  }
  const kidsOfNode = (id) => kidsOf.get(id) || [];
  function shownOf(id) {
    if (isRoot(id)) return true;
    const p = id === null ? null : parentOf(id);
    return id !== null && L.shown.has(id) && p !== null && isOpen(p) && shownOf(p);
  }
  const isOpen = (id) => isRoot(id) || L.open.has(id);

  // ---------------------------------------------------------------------------------------------------------
  // Time: a node's merged intervals in a unit, and its time in every unit, in ms.

  function mergeFlat(list) {
    const pairs = [];
    for (let k = 0; k < list.length; k += 2) pairs.push([list[k], list[k + 1]]);
    pairs.sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [x, y] of pairs) {
      if (out.length && x <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], y);
      else out.push(x, y);
    }
    return out;
  }
  function raw(i, id) {
    const U = units[i], p = pathOf(id);
    if (p >= 0) {
      const j = entry(i, p), out = [];
      const main = isPath(id) && !independentOf(id), off = main ? U.mainOff : U.off, a = main ? U.mainA : U.a, b = main ? U.mainB : U.b;
      if (j >= 0) for (let k = off[j]; k < off[j + 1]; k++) out.push(a[k], b[k]);
      return out;
    }
    if (id === REST) {
      let busy = [];
      for (const p of paths[rootPath].kids) if (!paths[p].independent) busy = unite(busy, raw(i, paths[p].key));
      return outside(busy, U.L);
    }
    let iv = [];
    for (const m of L.groups.get(id)?.members || []) iv = unite(iv, raw(i, m));
    return iv;
  }
  // Ownership and exclusions depend on the layout, not the compilation. Resolve them once; a large merged
  // projection must not walk all its members' ancestry again for every unit when it is added or opened.
  const coverageCache = new Map();
  function coverageOf(id) {
    if (coverageCache.has(id)) return coverageCache.get(id);
    const d = {members: L.groups.get(id)?.members, transferred: [], excluded: []};
    if (pathOf(id) >= 0 && !independentOf(id)) d.transferred = transfers.filter((m) =>
      m !== id && treeOf(m) === treeOf(id) && inside(m, id) && !inside(id, m) && !structuralInside(m, id) && !independentOf(m));
    for (let p = id; p !== null; p = callParent(p)) d.excluded.push(...(L.except.get(p) || []));
    coverageCache.set(id, d);
    return d;
  }
  function intervals(i, id) {
    const d = coverageOf(id);
    let iv = d.members ? d.members.reduce((a, m) => unite(a, intervals(i, m)), []) : raw(i, id);
    // A path loses only the effective coverage extracted outside its structural ancestry.
    for (const m of d.transferred) iv = subtract(iv, intervals(i, m));
    for (const m of d.excluded) iv = subtract(iv, raw(i, m));
    return iv;
  }
  const covered = raw;
  const lengthOf = (iv) => { let s = 0; for (let k = 0; k < iv.length; k += 2) s += iv[k + 1] - iv[k]; return s; };
  function count(i, id) {
    if (pathOf(id) >= 0) { const j = entry(i, pathOf(id)); return j < 0 ? 0 : units[i].cnt[j]; }
    if (id === REST) return 0;
    return L.groups.get(id).members.reduce((s, m) => s + count(i, m), 0);
  }
  // Coverage caches depend on definitions and ownership; opening or hiding a part leaves them unchanged.
  const msCache = new Map();
  function msOf(id) {
    if (!msCache.has(id)) {
      const out = new Float64Array(X.NU);
      for (let i = 0; i < X.NU; i++) out[i] = lengthOf(intervals(i, id)) / 1000;
      msCache.set(id, out);
    }
    return msCache.get(id);
  }
  // A child's average share of its parent's time, over the units that have the parent; and in how many it occurs.
  function shareIn(id, parent) {
    const c = msOf(id), p = isRoot(parent) ? null : msOf(parent);
    let sum = 0, n = 0, seen = 0;
    for (let i = 0; i < X.NU; i++) {
      const total = p ? p[i] : units[i].L / 1000;
      if (total <= 0) continue;
      n++;
      sum += Math.min(1, c[i] / total);
      if (c[i] > 0) seen++;
    }
    return { share: n ? sum / n : 0, seen: n ? seen / n : 0 };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Changing what is shown.

  function descendants(id, out = []) { for (const k of kidsOfNode(id)) { out.push(k); descendants(k, out); } return out; }
  // Closed: what is under it waits, shown or open as it was, for when it opens again.
  function collapse(id) { L.open.delete(id); }
  // Opening a node shows what was shown under it before; the first time, its children that take a fair share of its
  // time, or with none, the largest. It stays open with all of them hidden.
  function expand(id) {
    L.open.add(id);
    if (!kidsOfNode(id).some((k) => L.shown.has(k))) for (const k of largest(kidsOfNode(id), id)) L.shown.add(k);
  }
  function largest(list, of) {
    const kids = list.map((k) => [k, shareIn(k, of).share]).sort((x, y) => y[1] - x[1]);
    const big = kids.filter(([, s]) => s >= BIG).slice(0, MAX_OPEN);
    return (big.length ? big : kids.slice(0, 1)).map(([k]) => k);
  }
  // Off the screen, and nothing under it remembered as shown or open; removed, its name and order too: added again,
  // it comes back as its spans are called, as it would the first time.
  function unshow(id, removed) {
    for (const d of descendants(id).concat(id)) {
      L.shown.delete(d); L.open.delete(d);
      if (removed) { L.names.delete(d); L.order.delete(d); }
    }
    if (removed) for (const list of L.order.values()) { const k = list.indexOf(id); if (k >= 0) list.splice(k, 1); }
  }
  // A hidden operand survives while another definition references it. Unreferenced groups removed from the
  // layout release their members; a remaining single part retains its name and exclusions.
  function drop(g) {
    unshow(g);
    L.groups.delete(g); L.except.delete(g); L.names.delete(g); L.order.delete(g); L.parents.delete(g);
    for (const list of L.order.values()) { const k = list.indexOf(g); if (k >= 0) list.splice(k, 1); }
  }
  function prune() {
    for (let changed = true; changed;) {
      changed = false;
      const referenced = new Set([...L.groups.values()].flatMap((d) => d.members));
      for (const [g, d] of [...L.groups]) {
        d.members = [...new Set(d.members)].filter(exists);
        if (!d.members.length || (!L.shown.has(g) && !referenced.has(g))) {
          for (const parent of L.groups.values()) parent.members = parent.members.filter((m) => m !== g);
          drop(g); changed = true;
        }
      }
      if (changed) relink();
    }
    for (const [id, p] of L.parents) if (!exists(id) || (!exists(p) && p !== ROOT2)) L.parents.delete(id);
  }
  // Removed: its parent still counts it; put at the top of the second tree, it leaves it; merged, it goes. A span
  // open with children shown leaves just its level: they move up to its parent, which holds them as it held it.
  const lifts = (id) => !L.groups.has(id) && pathOf(id) >= 0 && isOpen(id) && kidsOfNode(id).some((k) => L.shown.has(k));
  function hide(id) {
    if (memberOf.has(id)) { unshow(id); return; }
    if (lifts(id)) {
      L.skip.add(id);
      L.shown.delete(id); L.open.delete(id);
      relink();
      return;
    }
    unshow(id, true);
    if (L.groups.has(id)) { drop(id); relink(); }
    if (L.top2.delete(id)) relink();
  }
  // Left out of a node's time: spans inside it; put back, one at a time.
  function exclude(id, spans) {
    const list = L.except.get(id) || [];
    for (const m of spans) {
      if (m === id || !exists(m) || !contains(id, m) || (treeOf(id) === 1 && independentOf(m))) continue;
      const d = L.groups.get(id);
      if (d && d.members.includes(m)) { leave(m, id); continue; }
      if (!list.includes(m)) list.push(m);
      unshow(m);
    }
    const kept = list.filter((m) => !list.some((x) => x !== m && rawInside(m, x)));
    if (kept.length) L.except.set(id, kept); else L.except.delete(id);
  }
  function unexclude(id, span) {
    const list = (L.except.get(id) || []).filter((m) => m !== span);
    if (list.length) L.except.set(id, list); else L.except.delete(id);
  }
  // Spans into a node's time: into a merged one; a span becomes a merged one of it and them, its name kept.
  function include(id, spans) {
    if (L.groups.has(id)) { for (const m of spans) join(m, id); return id; }
    return merge([id, ...spans], label(id));
  }
  // Shown, with whatever lies between it and the node it was added under; a copy added at the top of the second tree
  // goes there, unless it is in it already.
  function add(ids, under) {
    for (const id of ids) if (under === ROOT2 && isCopy(id) && !in2.has(id.slice(1))) L.top2.add(id);
    // Added back where it was taken out from between, it holds its children again.
    for (const id of ids) L.skip.delete(id);
    relink();
    for (const id of ids) showUp(id, under);
  }
  // Shown, with every node above it shown and open, up to `stop`.
  function showUp(id, stop) {
    for (let k = id; k !== null && k !== stop && !isRoot(k); k = parentOf(k)) {
      L.shown.add(k);
      const p = parentOf(k);
      if (p !== null && !isRoot(p)) L.open.add(p);
    }
  }
  // A node's spans: its own, or a merged node's members.
  const spansOf = (id) => (L.groups.has(id) ? L.groups.get(id).members.flatMap(spansOf) : [id]);
  // How many merged nodes a merged node is inside; the merged nodes inside it, it included.
  const levelOf = (g) => { let n = 0; for (let q = memberOf.get(g); q; q = memberOf.get(q)) n++; return n; };
  function within(g) {
    const out = new Set([g]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [h, d] of L.groups) if (!out.has(h) && out.has(d.parent)) { out.add(h); grew = true; }
    }
    return out;
  }
  // The deepest merged node all of them are inside, none of them being it or holding it.
  function homeOf(list) {
    let home = null;
    for (const g of L.groups.keys()) {
      if (list.some((x) => x === g || structuralInside(g, x)) || !list.every((x) => structuralInside(x, g))) continue;
      if (home === null || levelOf(g) > levelOf(home)) home = g;
    }
    return home;
  }
  // Spans out of the merged nodes they are in, but `keep` and those it is inside; one left with fewer than two goes.
  function free(list, keep) {
    for (const [g, d] of L.groups) if (g !== keep) d.members = d.members.filter((x) => !list.includes(x));
    for (const m of list) { L.top2.delete(m); L.parents.delete(m); }
  }
  // A node before or after a sibling, its subtree with it.
  function move(id, next, after) {
    const p = parentOf(id);
    if (p === null || id === next || parentOf(next) !== p) return;
    const list = kidsOfNode(p).filter((k) => k !== id);
    list.splice(list.indexOf(next) + (after ? 1 : 0), 0, id);
    L.order.set(p, list);
  }
  // Whether two shown nodes can be one: in one tree, neither its root, nor inside the other.
  const canMerge = (x, y) => exists(x) && exists(y) && x !== y && !isRoot(x) && !isRoot(y) && treeOf(x) === treeOf(y) && !structuralInside(x, y) && !structuralInside(y, x) && (treeOf(x) === 2 || (!independentOf(x) && !independentOf(y)));
  // Compose the picked definitions as parts, retaining exclusions, names and nested operands. A group made
  // inside another replaces those memberships with one reference to the new group.
  function merge(ids, name, match, keep = true) {
    const pick = [...new Set(ids)].filter((id) => exists(id) && !isRoot(id));
    const tree = pick.length ? treeOf(pick[0]) : 1;
    const picked = pick.filter((x) => treeOf(x) === tree && (tree === 2 || !independentOf(x)));
    const members = picked.filter((x) => !picked.some((y) => x !== y && structuralInside(x, y)));
    if (members.length < 2) { add(members, tree === 2 ? ROOT2 : null); return members[0] || null; }
    const home = homeOf(members), seen = new Set(keep ? members.filter(shownOf) : []);
    const id = `g${L.next++}`;
    free(members, null);
    L.groups.set(id, Object.assign({ label: name || suggestName(members), members }, tree === 2 ? { tree } : {}, match ? { match } : {}));
    if (home && L.groups.has(home)) L.groups.get(home).members.push(id);
    relink();
    for (const m of members) if (!seen.has(m)) unshow(m);
    if (seen.size) L.open.add(id);
    showUp(id);
    return id;
  }
  // A merged node taken into another: it goes; what was shown under it stays shown, under the other.
  function absorb(g) {
    L.shown.delete(g); L.open.delete(g); L.except.delete(g); L.names.delete(g); L.order.delete(g);
    L.groups.delete(g);
  }
  // The span a merged node's spans are all inside, when it is not on screen: the merged node made that span, which
  // then shows where it was, open, with what was shown under the merged node under it. A level removed comes back so.
  function promotable(g) {
    const d = L.groups.get(g);
    if (!d) return null;
    const a = anchor(g), span = d.tree === 2 ? copyOf(paths[a].key) : paths[a].key;
    return a === rootPath || shownOf(span) ? null : span;
  }
  function promote(g) {
    const span = promotable(g);
    if (span === null) return null;
    const d = L.groups.get(g), seen = d.members.filter((m) => shownOf(m));
    const parent = memberOf.get(g);
    free([span], parent);
    if (parent) L.groups.get(parent).members = L.groups.get(parent).members.filter((m) => m !== span).map((m) => m === g ? span : m);
    absorb(g);
    L.skip.delete(span);
    if (isCopy(span) && !in2.has(span.slice(1))) L.top2.add(span);
    relink();
    showUp(span);
    L.open.add(span);
    for (const m of seen) showUp(m);
    return span;
  }
  // The nearest span holding all of several nodes, when it is off screen (taken out from above them), to put back.
  function dominator(ids) {
    const list = ids.filter((id) => exists(id) && !isRoot(id));
    if (list.length < 2 || list.some((id) => treeOf(id) !== treeOf(list[0]))) return null;
    let lca = -1;
    for (const id of list) lca = lca < 0 ? anchor(id) : common(lca, anchor(id));
    if (lca < 0 || lca === rootPath) return null;
    const span = treeOf(list[0]) === 2 ? copyOf(paths[lca].key) : paths[lca].key;
    return L.skip.has(span) && !list.includes(span) ? span : null;
  }
  // Levels taken out from above a node, outermost first; one put back holds what is under it again.
  function skippedAbove(id) {
    const out = [];
    for (let up = callParent(id); up !== null && L.skip.has(up); up = callParent(up)) out.unshift(up);
    return out;
  }
  function unskip(id) {
    if (!L.skip.delete(id)) return;
    relink();
    showUp(id);
    L.open.add(id);
  }
  // A level taken out and then shown again, by opening its parent, splitting up or anything else, is back: it holds its
  // children again, open when one of them is shown, as if put back from the card.
  function settle() {
    const back = [...L.skip].filter((id) => L.shown.has(id));
    if (!back.length) return;
    for (const id of back) L.skip.delete(id);
    relink();
    for (const id of back) if (kidsOfNode(id).some((k) => L.shown.has(k))) L.open.add(id);
  }
  // Add a complete definition as a part; membership and display state are independent.
  function join(id, into) {
    if (!L.groups.has(into) || !canMerge(id, into)) return null;
    const parent = memberOf.get(into);
    if (parent && !inside(id, parent)) return null;
    free([id], null);
    L.groups.get(into).members.push(id);
    relink(); showUp(into);
    return into;
  }
  // Remove a direct part from a definition and return it to the surrounding composition or its call ancestry.
  function leave(id, from) {
    const g = from || memberOf.get(id), d = L.groups.get(g);
    if (!d || !d.members.includes(id)) return;
    const parent = memberOf.get(g);
    d.members = d.members.filter((x) => x !== id);
    if (parent) L.groups.get(parent).members.push(id);
    relink();
    if (isCopy(id) && parentOf(id) === null) { L.top2.add(id); relink(); }
    showUp(id);
  }
  // A merged node split up: its spans go where they belong, a copy left nowhere to the top of the second tree. Shown,
  // it leaves its larger spans shown, as opening it would, and the rest behind the + of where they go.
  function ungroup(id) {
    const d = L.groups.get(id);
    if (!d) return;
    const keep = shownOf(id) ? largest(d.members, id) : [];
    const parent = memberOf.get(id);
    if (parent) L.groups.get(parent).members = L.groups.get(parent).members.flatMap((m) => m === id ? d.members : [m]);
    for (const m of d.members) if (L.except.has(id)) L.except.set(m, [...new Set([...(L.except.get(m) || []), ...L.except.get(id)])]);
    drop(id);
    relink();
    for (const m of d.members) if (isCopy(m) && parentOf(m) === null) L.top2.add(m);
    relink();
    for (const m of keep) showUp(m);
  }
  // A node of the first tree copied to the top of the second: a path as its copy, a merged node with its members.
  function duplicate(id, tree, remove) {
    const mapping = new Map(), source = state(), sourceTree = treeOf(id);
    const scope = paths.map((p) => sourceTree === 2 ? copyOf(p.key) : p.key).concat([...L.groups.keys()])
      .filter((x) => treeOf(x) === sourceTree && structuralInside(x, id));
    const dup = (x) => {
      if (mapping.has(x)) return mapping.get(x);
      const p = pathOf(x), y = p >= 0 ? (tree === 2 ? copyOf(paths[p].key) : paths[p].key) : `g${L.next++}`;
      mapping.set(x, y);
      if (L.groups.has(x)) {
        const d = L.groups.get(x);
        L.groups.set(y, { label: d.label, members: d.members.map(dup), ...(tree === 2 ? { tree: 2 } : {}) });
      }
      return y;
    };
    const out = dup(id);
    for (const x of scope) dup(x);
    const targets = new Set(mapping.values()), freshGroups = new Set([...targets].filter((m) => L.groups.has(m)));
    for (const [g, d] of L.groups) if (!freshGroups.has(g) && (d.tree === 2 ? 2 : 1) === tree) d.members = d.members.filter((m) => !targets.has(m));
    const names = new Map(source.names), exclusions = new Map(source.except), orders = new Map(source.order), parents = new Map(source.parents);
    for (const [x, y] of mapping) {
      L.shown.delete(y); L.open.delete(y); L.skip.delete(y); L.parents.delete(y); L.top2.delete(y); L.names.delete(y); L.except.delete(y); L.order.delete(y);
      if (source.shown.includes(x)) L.shown.add(y);
      if (source.open.includes(x)) L.open.add(y);
      if (source.skip.includes(x)) L.skip.add(y);
      if (names.has(x)) L.names.set(y, names.get(x));
      if (exclusions.has(x)) L.except.set(y, exclusions.get(x).map((m) => tree === 2 ? copyOf(paths[pathOf(m)].key) : paths[pathOf(m)].key));
      if (orders.has(x)) L.order.set(y, orders.get(x).filter((m) => mapping.has(m)).map((m) => mapping.get(m)));
      if (mapping.has(parents.get(x))) L.parents.set(y, mapping.get(parents.get(x)));
      if (remove) { L.shown.delete(x); L.open.delete(x); L.skip.delete(x); L.groups.delete(x); L.except.delete(x); L.names.delete(x); L.order.delete(x); L.parents.delete(x); L.top2.delete(x); }
    }
    if (remove) for (const d of L.groups.values()) d.members = d.members.filter((m) => !mapping.has(m));
    return out;
  }
  function copyOver(id) {
    if (treeOf(id) !== 1 || isRoot(id) || !exists(id)) return null;
    const c = duplicate(id, 2, false);
    if (isCopy(c)) L.top2.add(c);
    relink(); showUp(c);
    return c;
  }
  function destinations(id) {
    if (!exists(id) || isRoot(id) || id === REST) return [];
    if (treeOf(id) === 1) return [{ id: ROOT2, label: 'Projections' }];
    if (independentOf(id)) return [];
    const spans = spansOf(id).map((m) => paths[pathOf(m)].key);
    return [rootKey(), ...paths.filter((p) => p.id !== rootPath && !p.independent && spans.every((m) => rawInside(m, p.key) && m !== p.key)).map((p) => p.key)]
      .concat([...L.groups].filter(([, d]) => d.tree !== 2).map(([g]) => g))
      .filter((p) => !independentOf(p) && spans.every((m) => {
        if (!contains(p, m)) return false;
        for (let q = p; q !== null; q = callParent(q)) if (excludedBy(q, m)) return false;
        return true;
      }))
      .map((p) => ({ id: p, label: label(p) }));
  }
  function transferPreview(id, target) {
    const spans = spansOf(id), affected = new Set();
    if (target !== ROOT2) for (const m of spans) {
      const primary = paths[pathOf(m)].key;
      for (let q = callParent(primary); q !== null && q !== target && !isRoot(q); q = callParent(q)) {
        if (shownOf(q)) affected.add(label(q));
      }
    }
    return target === ROOT2 ? 'Moves this definition to Projections; releases its spans in the main tree.'
      : `Into ${label(target)} · transfers ${spans.length} ${spans.length === 1 ? 'span' : 'spans'}${affected.size ? ` from ${[...affected].join(', ')}` : ''}.`;
  }
  function transfer(id, target) {
    if (!destinations(id).some((d) => d.id === target)) return null;
    const tree = target === ROOT2 ? 2 : 1, out = duplicate(id, tree, true);
    if (target === ROOT2 && isCopy(out)) L.top2.add(out);
    else if (L.groups.has(target)) L.groups.get(target).members.push(out);
    else L.parents.set(out, target);
    relink(); showUp(out);
    return out;
  }
  // Any node can be renamed; a path or the rest given back its spans' name, or none, is called that again.
  function rename(id, name) {
    const v = (name || '').trim();
    if (L.groups.has(id)) { if (v) L.groups.get(id).label = v; return; }
    if (!spanName(id)) return;
    if (!v || v === spanName(id)) L.names.delete(id); else L.names.set(id, v);
  }
  // What a merged node is called before it is named: what its members' names begin with, else the first's and more.
  function suggestName(members) {
    const names = members.map(label);
    if (!names.length) return 'Merged spans';
    let pre = names[0];
    for (const s of names) while (!s.startsWith(pre)) pre = pre.slice(0, -1);
    pre = pre.replace(/[\s:,.(-]+$/, '');
    return pre.length >= 3 ? pre : names[0];
  }

  // What the + of a shown node offers: its children not shown, largest first; with a filter, anything not shown
  // inside it whose name has the text, with where it is.
  // What a + offers, not shown: the node's children, then everything deeper under it (deep), each largest first; a
  // filter keeps those whose name has the text. The second tree's + offers any span of the unit, as a copy, and its
  // own merged nodes.
  function candidates(under, query) {
    const q = (query || '').trim().toLowerCase(), out = [];
    const found = (s) => s && s.toLowerCase().includes(q);
    const offer = (k, name, trail, deep) => { if (!shownOf(k) && (!q || found(name) || found(spanName(k)))) out.push({ id: k, label: name, where: trail.join(' › '), group: L.groups.has(k), deep }); };
    const walk = (id, trail, deep) => {
      for (const k of kidsOfNode(id)) {
        offer(k, label(k), trail, deep);
        walk(k, [...trail, label(k)], true);
      }
    };
    const anywhere = (p, trail, deep) => {
      for (const c of paths[p].kids) {
        offer(copyOf(paths[c].key), label(copyOf(paths[c].key)), trail, deep);
        anywhere(c, [...trail, paths[c].name], true);
      }
    };
    if (under === ROOT2) {
      anywhere(rootPath, [], false);
      for (const k of kidsOfNode(ROOT2)) if (L.groups.has(k)) offer(k, label(k), [], false);
    } else walk(under, [], false);
    const rows = out.slice(0, 400).map((c) => Object.assign(c, shareIn(c.id, under)));
    return rows.sort((x, y) => x.deep - y.deep || y.share - x.share);
  }

  // For a node's card: spans anywhere in its tree to put into its time, or spans inside it to leave out, the
  // filter typed; untyped, its own children for leaving out, nothing to put in.
  function spansFor(id, query, mode) {
    const q = (query || '').trim().toLowerCase(), out = [], tree = treeOf(id), less = L.except.get(id) || [];
    const found = (s) => s && s.toLowerCase().includes(q);
    const idOf = (p) => (tree === 2 ? copyOf(paths[p].key) : paths[p].key);
    const walk = (p, trail) => {
      for (const c of paths[p].kids) {
        const k = idOf(c), name = paths[c].name, within = inside(k, id) && k !== id;
        const fits = mode === 'exclude' ? within && contains(id, k) && !less.some((m) => rawInside(k, m)) && !transfers.some((m) => m !== id && treeOf(m) === tree && inside(k, m) && inside(m, id) && !structuralInside(m, id))
          : !within && k !== id && !inside(id, k);
        if (fits && (mode !== 'include' || !memberOf.has(id) || inside(k, memberOf.get(id))) && (q ? found(name) : spansOf(id).includes(idOf(p)))) out.push({ id: k, label: name, where: trail.join(' › '), group: false });
        if (q || mode === 'exclude') walk(c, [...trail, name]);
      }
    };
    if (q || mode === 'exclude') walk(rootPath, []);
    const rows = out.slice(0, 400).map((c) => Object.assign(c, shareIn(c.id, mode === 'exclude' ? id : rootKey())));
    return rows.sort((x, y) => y.share - x.share);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Applying what is shown: the columns, each unit's time in them, and each span's column.

  let ownerOf = new Int32Array(0), version = 0;
  const FAMILIES = 4;

  function frames(iv, total) {
    const G = X.GRID, grid = [];
    for (let k = 0; k < iv.length; k += 2) {
      if (iv[k + 1] <= 0 || iv[k] >= total) continue;
      const a = Math.floor(Math.max(0,iv[k]) * G / total), b = Math.min(G, Math.max(a + 1, Math.ceil(iv[k + 1] * G / total)));
      if (grid.length && a <= grid[grid.length - 1]) grid[grid.length - 1] = Math.max(grid[grid.length - 1], b);
      else grid.push(a, b);
    }
    const out = [];
    let at = 0;
    for (let k = 0; k < grid.length; k += 2) { out.push(grid[k] - at, grid[k + 1] - grid[k]); at = grid[k + 1]; }
    return out;
  }
  // iv less taken (both merged): what is left, and its length.
  function subtract(iv, taken) {
    const out = [];
    let j = 0;
    for (let k = 0; k < iv.length; k += 2) {
      let at = iv[k];
      const e = iv[k + 1];
      while (j < taken.length && taken[j + 1] <= at) j += 2;
      for (let q = j; q < taken.length && taken[q] < e; q += 2) {
        if (taken[q] > at) out.push(at, taken[q]);
        at = Math.max(at, taken[q + 1]);
      }
      if (at < e) out.push(at, e);
    }
    return out;
  }

  // Per node, what every unit has of it: its intervals, share, frames on the grid and count of spans; kept while the
  // node is made the same, so a change works out only the columns it changes.
  const sigOf = (id) => `${definitionVersion}|${id}`;
  const nodeCache = new Map();
  function nodeData(id) {
    const key = sigOf(id);
    let d = nodeCache.get(key);
    if (d) { nodeCache.delete(key); nodeCache.set(key, d); return d; }
    d = { iv: new Array(X.NU), s: new Float64Array(X.NU), f: new Array(X.NU), c: new Int32Array(X.NU) };
    for (let i = 0; i < X.NU; i++) {
      const total = units[i].L, iv = intervals(i, id);
      d.iv[i] = iv; d.s[i] = lengthOf(iv) / total; d.f[i] = frames(iv, total); d.c[i] = count(i, id);
    }
    nodeCache.set(key, d);
    if (nodeCache.size > 64) nodeCache.delete(nodeCache.keys().next().value);
    return d;
  }
  // Two lists of intervals in order, apart from each other, as one.
  function unite(a, b) {
    const out = [];
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      let x, y;
      if (j >= b.length || (i < a.length && a[i] <= b[j])) { x = a[i]; y = a[i + 1]; i += 2; } else { x = b[j]; y = b[j + 1]; j += 2; }
      if (out.length && x <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], y);
      else out.push(x, y);
    }
    return out;
  }
  // Length of what two lists of disjoint intervals in order have in common; what a list leaves of [0, total).
  function overlap(a, b) {
    let i = 0, j = 0, len = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i], b[j]), hi = Math.min(a[i + 1], b[j + 1]);
      if (hi > lo) len += hi - lo;
      if (a[i + 1] < b[j + 1]) i += 2; else j += 2;
    }
    return len;
  }
  function outside(taken, total) {
    const out = [];
    let at = 0;
    for (let k = 0; k < taken.length; k += 2) { if (taken[k] > at) out.push(at, taken[k]); at = Math.max(at, taken[k + 1]); }
    if (at < total) out.push(at, total);
    return out;
  }

  // The duration overview examines the complete definitions, independently of which violins are open.
  // Assign every moment once, including overlaps, and retain the recorded children so "own" really means
  // outside child spans. Removed display levels do not erase their recorded work from this explanation.
  let breakdownCache = null;
  function breakdown() {
    const projection = X.proj?.(), key = JSON.stringify([definitionVersion, [...L.names], [...L.order],
      [...L.groups].map(([id, g]) => [id, g.label]), projection ? [version, X.scenarioKey()] : null]);
    if (breakdownCache?.key === key) return breakdownCache;
    const byParent = new Map();
    for (const id of [...paths.filter((p) => !p.independent && p.id !== rootPath).map((p) => p.key),
      ...[...L.groups.keys()].filter((id) => treeOf(id) === 1 && !independentOf(id))]) {
      const parent = callParent(id);
      if (parent !== null) (byParent.get(parent) || byParent.set(parent, []).get(parent)).push(id);
    }
    const nodes = [], children = [];
    const walk = (id, parent = -1, depth = 0) => {
      const k = nodes.length;
      nodes.push({id, label: label(id), parent, depth, merged: L.groups.has(id)}); children.push([]);
      if (parent >= 0) children[parent].push(k);
      const order = L.order.get(id) || [], rank = (x) => { const n = order.indexOf(x); return n < 0 ? Infinity : n; };
      for (const child of (byParent.get(id) || []).sort((a, b) => rank(a) - rank(b) || startOf(a) - startOf(b))) walk(child, k, depth + 1);
    };
    walk(rootKey());
    const none = nodes.length;
    nodes.push({id: '~unassigned', label: 'Outside the included spans', parent: -1, depth: 0}); children.push([]);
    const priority = nodes.slice(0, none).map((_, k) => k)
      .sort((a, b) => nodes[b].depth - nodes[a].depth || callDepth(nodes[b].id) - callDepth(nodes[a].id));
    // What-if factors still use the displayed violins' ownership in each tree. Integrate their exact interval
    // weights over the finer partition, rather than spreading a parent's saving evenly over its children.
    const visible = projection ? data.columns.map((c, k) => k).filter((k) => !data.columns[k].second || !data.columns[k].async)
      .sort((a, b) => X.depthIdx[b] - X.depthIdx[a] || callDepth(data.columns[b].id) - callDepth(data.columns[a].id)) : [];
    const rows = units.map((u, i) => {
      const events = [], segments = [];
      if (projection) for (const second of [false, true]) {
        let taken = [];
        for (const k of visible.filter((k) => data.columns[k].second === second)) {
          const piece = subtract(intervals(i, data.columns[k].id), taken);
          taken = unite(taken, piece);
          if (projection.eff[k] === 1) continue;
          for (let q = 0; q < piece.length; q += 2) {
            events.push([piece[q], Number(second), projection.eff[k], 1], [piece[q + 1], Number(second), 1, 0]);
          }
        }
      }
      events.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
      let at = 0; const factors = [1, 1];
      for (const [t, tree, factor] of events) {
        if (t > at) segments.push([at, t, factors[0] * factors[1]]);
        at = t; factors[tree] = factor;
      }
      if (at < u.L) segments.push([at, u.L, factors[0] * factors[1]]);
      const length = (iv) => {
        if (!projection) return lengthOf(iv);
        let total = 0, j = 0;
        for (let q = 0; q < iv.length; q += 2) {
          while (j < segments.length && segments[j][1] <= iv[q]) j++;
          for (let s = j; s < segments.length && segments[s][0] < iv[q + 1]; s++)
            total += Math.max(0, Math.min(iv[q + 1], segments[s][1]) - Math.max(iv[q], segments[s][0])) * segments[s][2];
        }
        return total;
      };
      const row = new Float64Array(nodes.length); let taken = [];
      for (const k of priority) {
        const piece = subtract(intervals(i, nodes[k].id), taken);
        row[k] = length(piece) / u.L; taken = unite(taken, piece);
      }
      row[none] = length(outside(taken, u.L)) / u.L;
      return row;
    });
    return (breakdownCache = {key, nodes, children, tops: [0], none, rows});
  }

  function apply() {
    const root = rootKey(), cols = [];
    const walk = (id, depth, tree) => {
      for (const k of kidsOfNode(id)) {
        if (!L.shown.has(k)) continue;
        cols.push({ id: k, label: label(k), parent: id === root ? X.ROOT : id, depth, merged: L.groups.has(k), tree, async: flowOf(k), dependency: dependencyOf(k), independent: independentOf(k) });
        if (isOpen(k)) walk(k, depth + 1, tree);
      }
    };
    walk(root, 1, 1);
    const N1 = cols.length;
    walk(ROOT2, 1, 2);
    // Colours by the top-level column a column is under: the first FAMILIES in order, the rest, and the second tree, in
    // grey.
    let top = 0, family = 'other';
    for (const c of cols) {
      if (c.depth === 1) family = c.id === REST || c.tree === 2 || top >= FAMILIES ? 'other' : `f${top++}`;
      c.family = family;
    }
    const NC = cols.length, at = new Map(cols.map((c, k) => [c.id, k]));
    data.columns = cols.map(({ id, label: l, parent, merged, tree, async, dependency, independent }) => ({ id, label: l, parent, merged, async, dependency, independent, second: tree === 2 }));
    // The split of a unit's time is the first tree's; the second takes nothing from it.
    data.partition = cols.slice(0, N1).map((c) => ({ id: c.id, label: c.label, family: c.family, from: [c.id] }))
      .concat([{ id: '~none', label: 'Under no violin', family: 'other', from: [] }]);
    // Which column counts a moment covered by several, in each tree: the deepest shown, then the deepest in the call
    // tree.
    const order = (a, b) => Array.from({ length: b - a }, (_, k) => a + k)
      .sort((x, y) => cols[y].depth - cols[x].depth || callDepth(cols[y].id) - callDepth(cols[x].id));
    const prio = order(0, N1), prio2 = order(N1, NC).filter((k) => !cols[k].async);
    X.countFor = new Map();
    const repeats = new Uint8Array(NC);
    const made = cols.map((col) => nodeData(col.id));
    for (let i = 0; i < X.NU; i++) {
      const u = data.units[i], total = units[i].L;
      const s = new Float64Array(NC), fr = new Array(NC), c = new Int32Array(NC), p = new Float64Array(N1 + 1), own = new Float64Array(NC);
      const iv = new Array(NC), piece = new Array(NC);
      for (let k = 0; k < NC; k++) {
        const d = made[k];
        iv[k] = d.iv[i]; s[k] = d.s[i]; fr[k] = d.f[i]; c[k] = d.c[i];
        if (c[k] > 1) repeats[k] = 1;
      }
      // Each column's own time in its tree: what deeper columns of that tree don't count.
      const split = (list) => {
        let taken = [];
        for (const k of list) {
          piece[k] = subtract(iv[k], taken);
          own[k] = lengthOf(piece[k]) / total;
          taken = unite(taken, piece[k]);
        }
        return taken;
      };
      const none = outside(split(prio), total);
      for (let k = 0; k < N1; k++) p[k] = own[k];
      p[N1] = lengthOf(none) / total;
      // Where the second tree's own times meet the first's (k = -1: under no violin there), for the what-if.
      let x = null;
      if (N1 < NC) {
        split(prio2);
        const cells = [];
        for (let j = N1; j < NC; j++) {
          if (!piece[j]?.length) continue;
          for (let k = -1; k < N1; k++) {
            const len = overlap(piece[j], k < 0 ? none : piece[k]);
            if (len > 0) cells.push(k, j, len / total);
          }
        }
        x = Float64Array.from(cells);
      }
      u.s = s; u.f = fr; u.c = c; u.p = p; u.o = own; u.x = x;
    }
    repeats.forEach((r, k) => { if (r) X.countFor.set(k, k); });
    // Each path's column in the first tree: its own, or that of the nearest merged node or path above it that is shown.
    ownerOf = new Int32Array(paths.length).fill(-1);
    for (const P of paths) {
      let id = P.independent ? copyOf(P.key) : P.key, found = -1;
      for (let q = id; q !== null && found < 0; q = parentOf(q)) {
        if (at.has(q) && contains(q, id)) found = at.get(q);
      }
      ownerOf[P.id] = found;
    }
    version++;
    X.reindex();
    X.tokens();
    save();
    X.emit('layout');
  }

  // ---------------------------------------------------------------------------------------------------------
  // Keeping it. A layout is what is shown, merged and renamed, by path, so it survives building the data again. One
  // saved into the page (data/layout.js, or inside a page downloaded as one file) is where everyone starts; the
  // viewer's own changes are kept in the browser, for each kind of unit, until the page has a newer one saved in it.

  const saved = () => window.EXPLORER_LAYOUT || null;
  const savedAt = () => (saved() ? saved().saved : null);
  function state() {
    return { v: 4, parents: [...L.parents], shown: [...L.shown], open: [...L.open], order: [...L.order], except: [...L.except], skip: [...L.skip], next: L.next, names: [...L.names], top2: [...L.top2],
      groups: [...L.groups].map(([id, d]) => [id, d.label, d.members,
        Object.assign({}, d.tree === 2 ? { tree: 2 } : {}, d.match ? { match: d.match } : {}, d.parent ? { parent: d.parent } : {})]) };
  }
  // Older layouts could put parallel work in the elapsed-time tree. Move that work to independent definitions.
  function separateAsync() {
    const claimed = new Set([...L.groups.values()].filter((d) => d.tree === 2).flatMap((d) => d.members));
    const convert = (id) => {
      if (pathOf(id) >= 0) {
        if (!isPath(id) || !independentOf(id)) return id;
        const to = copyOf(id);
        if (L.shown.delete(id)) L.shown.add(to);
        if (L.open.delete(id)) L.open.add(to);
        if (L.names.has(id)) { L.names.set(to, L.names.get(id)); L.names.delete(id); }
        if (L.except.has(id)) { L.except.set(to, L.except.get(id).map((m) => copyOf(m))); L.except.delete(id); }
        return to;
      }
      const d = L.groups.get(id);
      if (!d || d.tree === 2) return id;
      const members = d.members.map(convert), sync = members.filter((m) => treeOf(m) === 1), parallel = members.filter((m) => treeOf(m) === 2 && !claimed.has(m));
      if (sync.length === members.length) return id;
      for (const m of parallel) claimed.add(m);
      if (!parallel.length) { d.members = sync; return id; }
      if (!sync.length) { d.tree = 2; d.members = parallel; L.parents.delete(id); L.shown.add(id); }
      else {
        d.members = sync;
        const g = `g${L.next++}`;
        L.groups.set(g, {label: `${d.label} · separate flows`, members: parallel, tree: 2}); L.shown.add(g);
      }
      return id;
    };
    for (const id of [...L.groups.keys()]) convert(id);
    for (const id of [...L.shown]) convert(id);
  }
  // Loading preserves nested definitions, including single parts left after explicit membership edits.
  function load(s, exact = false) {
    L.shown = new Set(); L.groups = new Map(); L.names = new Map(); L.top2 = new Set(); L.open = new Set(); L.order = new Map(); L.parents = new Map(); L.except = new Map(); L.skip = new Set(); L.next = 1;
    if (!s) return false;
    const groups = new Map((s.groups || []).map(([id, name, members, more]) => [id, Object.assign({ label: name, members }, more || {})]));
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, d] of groups) {
        const ok = d.members.filter((m) => isPath(m) || isCopy(m) || m === REST || groups.has(m));
        if (ok.length !== d.members.length) { d.members = ok; changed = true; }
        if (ok.length < 1) { groups.delete(id); changed = true; }
      }
    }
    // Migrate the old nested-group relation into actual composition, keeping each operand intact.
    for (const [id, d] of groups) if (d.parent && groups.has(d.parent)) {
      const parent = groups.get(d.parent);
      parent.members = parent.members.filter((m) => !d.members.includes(m));
      if (!parent.members.includes(id)) parent.members.push(id);
      delete d.parent;
    }
    L.groups = groups;
    for (const id of groups.keys()) L.next = Math.max(L.next, Number(id.slice(1)) + 1 || 1);
    L.next = Math.max(L.next, s.next || 1);
    for (const [id, name] of s.names || []) if (spanName(id) && name) L.names.set(id, name);
    for (const [id, p] of s.parents || []) if (exists(id) && (exists(p) || p === ROOT2)) L.parents.set(id, p);
    for (const id of s.top2 || []) if (isCopy(id)) L.top2.add(id);
    for (const [p, list] of s.order || []) L.order.set(p, list);
    for (const id of s.skip || []) if (pathOf(id) >= 0) L.skip.add(id);
    relink();
    for (const [id, list] of s.except || []) if (exists(id)) { const ok = list.filter((m) => pathOf(m) >= 0); if (ok.length) L.except.set(id, ok); }
    for (const id of s.shown || []) if (exists(id)) L.shown.add(id);
    for (const id of s.open || []) if (exists(id)) L.open.add(id);
    // Saved before closing kept what was under a node: every node with a child shown was open.
    if (!s.v || s.v < 2) for (const id of L.shown) { const p = parentOf(id); if (p !== null && !isRoot(p)) L.open.add(p); }
    if (!exact) separateAsync();
    relink();
    if (!exact && (s.v || 0) < 4) for (const P of paths) {
      const id = P.key, parent = parentOf(id);
      if (P.dependency && !P.independent && parent !== null && L.shown.has(parent) && !L.skip.has(id)
          && !memberOf.has(id) && !L.parents.has(id) && contains(parent, id)) {
        L.shown.add(id); L.open.add(parent);
      }
    }
    settle();
    prune();
    if (!exact) rematch();
    return L.shown.size > 0;
  }
  // Merged nodes made from a filter's every match take in what matches it now and is in no other: spans read again
  // may have it in new places.
  function rematch() {
    for (const [id, d] of L.groups) {
      if (!d.match) continue;
      const under = d.match.under === ROOT2 || exists(d.match.under) ? d.match.under : d.tree === 2 ? ROOT2 : rootKey();
      const more = candidates(under, d.match.text).map((c) => c.id)
        .filter((m) => pathOf(m) >= 0 && !memberOf.has(m) && !d.members.some((x) => inside(m, x) || inside(x, m)));
      if (!more.length) continue;
      d.members.push(...more.filter((m) => !more.some((y) => y !== m && inside(m, y))));
      relink();
    }
  }
  function fresh() { load(null); relink(); expand(rootKey()); }
  // Back to where everyone starts.
  function reset() { if (!(saved() && load(saved().layout))) fresh(); }

  const storeKey = () => `violinoscope.layout.${paths[rootPath].name}`;
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ base: savedAt(), layout: state() }));
    } catch (e) { /* storage off: the layout lasts as long as the page */ }
  }
  function restore() {
    let own = null;
    try { own = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (e) { own = null; }
    if (!own) return false;
    // Kept before it was called a layout, or changed since the one saved into the page: still the viewer's.
    if (!own.layout) own = { base: null, layout: own };
    return (own.base || null) === savedAt() && load(own.layout);
  }

  function start() {
    ready = true;
    if (!meta.unit) X.UNIT = paths[rootPath].name;
    relink();
    if (!restore()) reset();
    apply();
  }

  // ---------------------------------------------------------------------------------------------------------

  const past = [], future = [];
  const snapshot = () => JSON.stringify(state());
  function restoreSnapshot(value) {
    load(JSON.parse(value), true); relink(); settle(); apply(); X.render(); X.emit('history', {edit:false});
  }
  function undo() { if (!past.length) return false; future.push(snapshot()); restoreSnapshot(past.pop()); return true; }
  function redo() { if (!future.length) return false; past.push(snapshot()); restoreSnapshot(future.pop()); return true; }
  function check() {
    const seen = new Set();
    for (const [g, d] of L.groups) {
      if (!d.members.length) throw new Error(`Empty violin: ${g}`);
      for (const m of d.members) {
        if (!exists(m) || treeOf(m) !== treeOf(g) || seen.has(m)) throw new Error(`Invalid or duplicate member: ${m}`);
        seen.add(m);
      }
    }
    for (const id of paths.map((p) => p.key).concat([...in2].map(copyOf), [...L.groups.keys()])) {
      const ancestors = new Set();
      for (let p = id; p !== null; p = callParent(p)) {
        if (ancestors.has(p)) throw new Error(`Cycle at ${p}`);
        ancestors.add(p);
      }
    }
    for (const id of L.skip) if (L.shown.has(id)) throw new Error(`Shown removed level: ${id}`);
    const columns = new Map(data.columns.map((c, k) => [c.id, k]));
    for (const u of data.units) {
      for (let k = 0; k < data.columns.length; k++) {
        const p = columns.get(data.columns[k].parent);
        if (p !== undefined && u.s[k] > u.s[p] + 1e-8) throw new Error(`Child exceeds parent: ${data.columns[k].label}`);
      }
      if (u.p && Math.abs(u.p.reduce((a, b) => a + b, 0) - 1) > 1e-8) throw new Error('Elapsed time is not conserved');
      if (u.s && [...u.s].some((v) => !Number.isFinite(v) || v < 0)) throw new Error('Invalid time');
    }
    return true;
  }
  function change(f, action = f.name) { return (...args) => {
    const before = snapshot();
    try {
      const r = f(...args); relink(); settle(); prune(); relink();
      if (before === snapshot()) return r;
      apply();
      if (X.checkLayout) check();
      past.push(before); if (past.length > 100) past.shift(); future.length = 0;
      X.render(); X.emit('history', {edit:true, action});
      return r;
    } catch (e) { restoreSnapshot(before); throw e; }
  }; }


  X.layout = {
    get ready() { return ready; },
    get version() { return version; },
    progress: () => [X.chunksLoaded(), X.chunkCount],
    rootKey: () => (ready ? rootKey() : null),
    label, spanName, inside, parentOf, canMerge, treeOf,
    hasPath: (id) => pathByKey.has(id),
    normalize: (s) => {
      const before = JSON.parse(JSON.stringify(state()));
      try { load(JSON.parse(JSON.stringify(s))); return state(); }
      finally { load(before, true); }
    },
    // What a node is made of, as a key: the same while its time is.
    sig: sigOf,
    // The span a path runs under, by name.
    under: (id) => { const p = pathOf(id); return p >= 0 && paths[p].parent >= 0 ? paths[paths[p].parent].name : ''; },
    // The span names a node's paths have, each once.
    spanNames: (id) => {
      const out = new Set();
      const walk = (x) => { if (L.groups.has(x)) L.groups.get(x).members.forEach(walk); else if (pathOf(x) >= 0) out.add(spanName(x)); };
      walk(id);
      return [...out];
    },
    // How many spans a node has: one path, or a merged node's paths.
    size: (id) => { const n = (x) => (L.groups.has(x) ? L.groups.get(x).members.reduce((t, m) => t + n(m), 0) : 1); return n(id); },
    // Whether the second tree has anything in it.
    get second() { return kidsOfNode(ROOT2).length > 0; },
    candidates: (under, query) => candidates(under === X.ROOT ? rootKey() : under, query),
    kids: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id),
    shown: (id) => shownOf(id === X.ROOT ? rootKey() : id),
    isMerged: (id) => L.groups.has(id),
    // A merged node's spans; a path or the rest, itself.
    members: (id) => (L.groups.has(id) ? L.groups.get(id).members.slice() : exists(id) ? [id] : []),
    // A node's time in every unit, in ms.
    msOf,
    // Open (opened, or with children shown), and its children not shown.
    open: (id) => isOpen(id === X.ROOT ? rootKey() : id),
    hidden: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id).filter((k) => !L.shown.has(k)).length,
    // Whether anything under it, at any depth, is off screen: what its + offers.
    addable: (id) => { const any = (n) => kidsOfNode(n).some((k) => !L.shown.has(k) || any(k)); return any(id === X.ROOT ? rootKey() : id); },
    expand: change((id) => expand(id === X.ROOT ? rootKey() : id)),
    collapse: change((id) => collapse(id === X.ROOT ? rootKey() : id)),
    hide: change(hide),
    // Whether removing it leaves its children, moved up to its parent.
    lifts: (id) => lifts(id),
    promotable: (id) => promotable(id),
    promote: change(promote),
    skippedAbove: (id) => skippedAbove(id),
    dominator: (ids) => dominator(ids),
    unskip: change(unskip),
    exclude: change(exclude),
    unexclude: change(unexclude),
    include: change(include),
    excluded: (id) => (L.except.get(id) || []).slice(),
    spansFor,
    // Several at once.
    remove: change((ids) => { for (const id of ids) if (exists(id)) hide(id); }, 'remove'),
    add: change((ids, under) => add(ids, under === X.ROOT ? rootKey() : under)),
    merge: change(merge),
    join: change(join),
    leave: change(leave),
    move: change(move),
    copyOver: change(copyOver),
    ungroup: change(ungroup),
    rename: change(rename),
    suggestName: (ids) => suggestName(ids),
    reset: change(reset),
    // Back to the unit's span and its larger children, whatever the page was saved with.
    fresh: change(fresh),
    // What is shown, as data, to save into a page; and the layout saved into this one.
    state: () => JSON.parse(JSON.stringify(state())),
    load: change((s) => load(JSON.parse(JSON.stringify(s)))),
    check, undo, redo, breakdown, destinations, transferPreview, transfer: change(transfer),
    async: flowOf, independent: independentOf, dependency: dependencyOf,
    transferred: (id) => transfers.filter((m) => m !== id && treeOf(m) === treeOf(id) && inside(m, id) && !inside(id, m) && !structuralInside(m, id) && !independentOf(m))
      .filter((m, _, all) => !all.some((p) => p !== m && structuralInside(m, p)))
      .map((m) => ({ id: m, into: callParent(m) })),
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get saved() { return saved(); },
    // The column a span counts toward in the first tree, by its unit and row.
    partOfRow: (i, r) => (ready && units[i] ? ownerOf[units[i].rowPath[r]] : -1),
    partOfPath: (p) => (ready ? ownerOf[p] : -1),
    // Per path in a unit: the path, how many spans, their summed and self time in µs, for the spans table.
    pathsOf: (i) => units[i],
    path: (p) => paths[p],
  };
  X.on('chunk', indexChunk);
})();
