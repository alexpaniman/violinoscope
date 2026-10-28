// The violins as a tree built from the spans themselves. Every call path (a span name under its parent's path) is a
// node: the unit's own span at the root, the spans it calls under it, and so on. The Phases tab shows the root and
// whichever nodes the viewer opened, added or merged; a node's time in a unit is the time its spans cover there,
// overlaps counted once, cut to the unit. A merged node is several nodes as one: its time is theirs together, and it
// sits under the nearest path that holds them all. "Not under any span" is the unit's time that none of the spans it
// calls covers. What is shown is kept in the browser, for each kind of unit.
//
// From what is shown come the columns every view uses (data.columns), each unit's time in them (u.s, u.f, u.c), the
// split of each unit's time among them, deepest first (u.p, data.partition), and which column each span counts toward.
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
    const u = data.units[i], f = chunk.trees[i - u.k * meta.chunk].rows, n = f.length / 5;
    const L = n ? Math.max(1, f[3]) : 1;
    const rowPath = new Int32Array(n), keyOf = new Array(n), kids = new Array(n);
    for (let r = 0; r < n; r++) {
      const name = chunk.names[f[5 * r]], parent = f[5 * r + 1];
      keyOf[r] = parent >= 0 ? keyOf[parent] + SEP + name : name;
      rowPath[r] = intern(keyOf[r], name, parent >= 0 ? rowPath[parent] : -1);
      // A span's self time is its length less what its synchronous children cover.
      if (parent >= 0 && !(f[5 * r + 4] & 1)) (kids[parent] || (kids[parent] = [])).push(f[5 * r + 2], f[5 * r + 2] + f[5 * r + 3]);
    }
    if (n && rootPath < 0) rootPath = rowPath[0];
    const order = Array.from({ length: n }, (_, r) => r).sort((x, y) => rowPath[x] - rowPath[y] || f[5 * x + 2] - f[5 * y + 2]);
    const ids = [], off = [0], a = [], b = [], cnt = [], dur = [], self = [];
    for (let q = 0; q < n;) {
      const p = rowPath[order[q]], from = a.length;
      let c = 0, d = 0, s = 0;
      for (; q < n && rowPath[order[q]] === p; q++) {
        const r = order[q], s0 = f[5 * r + 2], s1 = s0 + f[5 * r + 3];
        c++; d += s1 - s0; s += Math.max(0, s1 - s0 - coveredIn(kids[r], s0, s1));
        const x0 = Math.max(0, s0), x1 = Math.min(L, s1);
        if (x1 <= x0) continue;
        if (a.length > from && x0 <= b[b.length - 1]) b[b.length - 1] = Math.max(b[b.length - 1], x1);
        else { a.push(x0); b.push(x1); }
      }
      let len = 0;
      for (let k = from; k < a.length; k++) len += b[k] - a[k];
      const P = paths[p];
      P.n++; P.share += len / L; P.start += a.length > from ? a[from] / L : 1;
      ids.push(p); off.push(a.length); cnt.push(c); dur.push(d); self.push(s);
    }
    units[i] = { L, rowPath, ids: Int32Array.from(ids), off: Int32Array.from(off), a: Float64Array.from(a), b: Float64Array.from(b),
      cnt: Int32Array.from(cnt), dur: Float64Array.from(dur), self: Float64Array.from(self) };
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
  // Nodes: paths by their key, merged nodes as g1, g2, …, and the rest.

  const L = { shown: new Set(), groups: new Map(), next: 1 };
  let memberOf = new Map();

  const isPath = (id) => pathByKey.has(id);
  const exists = (id) => isPath(id) || L.groups.has(id) || id === REST;
  const rootKey = () => paths[rootPath].key;
  function label(id) {
    if (isPath(id)) return paths[pathByKey.get(id)].name;
    if (L.groups.has(id)) return L.groups.get(id).label;
    if (id === REST) return 'Not under any span';
    return id;
  }

  // The path a node hangs from: a path its own; a merged node the nearest path holding all its members; the rest
  // the root. Its depth in the call tree, for which of two overlapping nodes counts a moment: the deeper.
  function anchor(id) {
    if (isPath(id)) return pathByKey.get(id);
    if (id === REST) return rootPath;
    let lca = -1;
    for (const m of L.groups.get(id).members) lca = lca < 0 ? anchor(m) : common(lca, anchor(m));
    return lca;
  }
  function common(p, q) {
    while (paths[p].depth > paths[q].depth) p = paths[p].parent;
    while (paths[q].depth > paths[p].depth) q = paths[q].parent;
    while (p !== q) { p = paths[p].parent; q = paths[q].parent; }
    return p;
  }
  function callDepth(id) {
    if (isPath(id)) return paths[pathByKey.get(id)].depth;
    if (id === REST) return 1;
    return Math.min(...L.groups.get(id).members.map(callDepth));
  }
  // Whether node x lies inside node y: under one of y's paths, or one of its members.
  function inside(x, y) {
    if (x === y) return true;
    if (L.groups.has(y)) return L.groups.get(y).members.some((m) => inside(x, m));
    if (y === REST || x === REST) return false;
    const py = pathByKey.get(y);
    for (let p = anchor(x); p >= 0; p = paths[p].parent) if (p === py) return x !== y;
    return false;
  }

  // Where a node shows: in the merged node it is part of, or under its path's parent, or under its anchor.
  function parentOf(id) {
    if (memberOf.has(id)) return memberOf.get(id);
    if (isPath(id)) { const p = paths[pathByKey.get(id)].parent; return p >= 0 ? paths[p].key : null; }
    if (id === REST) return rootKey();
    return paths[anchor(id)].key;
  }
  // Every node's children, shown or not; built again whenever what is merged changes.
  let kidsOf = new Map();
  function relink() {
    memberOf = new Map();
    for (const [g, d] of L.groups) for (const m of d.members) memberOf.set(m, g);
    kidsOf = new Map();
    const add = (id) => { const p = parentOf(id); if (p !== null) (kidsOf.get(p) || kidsOf.set(p, []).get(p)).push(id); };
    for (const P of paths) if (P.id !== rootPath) add(P.key);
    for (const g of L.groups.keys()) add(g);
    add(REST);
    for (const list of kidsOf.values()) list.sort((x, y) => startOf(x) - startOf(y));
  }
  // When a node usually starts in a unit, as a share of it, so children read in the order they run.
  function startOf(id) {
    if (isPath(id)) { const P = paths[pathByKey.get(id)]; return P.n ? P.start / P.n : 1; }
    if (id === REST) return 2;
    return Math.min(...L.groups.get(id).members.map(startOf));
  }
  const kidsOfNode = (id) => kidsOf.get(id) || [];
  function shownOf(id) { return id === rootKey() || (L.shown.has(id) && shownOf(parentOf(id))); }

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
  function intervals(i, id) {
    const U = units[i];
    if (isPath(id)) {
      const j = entry(i, pathByKey.get(id));
      if (j < 0) return [];
      const out = [];
      for (let k = U.off[j]; k < U.off[j + 1]; k++) out.push(U.a[k], U.b[k]);
      return out;
    }
    if (id === REST) {
      const top = [];
      for (const p of paths[rootPath].kids) top.push(...intervals(i, paths[p].key));
      const busy = mergeFlat(top), out = [];
      let at = 0;
      for (let k = 0; k < busy.length; k += 2) { if (busy[k] > at) out.push(at, busy[k]); at = Math.max(at, busy[k + 1]); }
      if (at < U.L) out.push(at, U.L);
      return out;
    }
    const all = [];
    for (const m of L.groups.get(id).members) all.push(...intervals(i, m));
    return mergeFlat(all);
  }
  const lengthOf = (iv) => { let s = 0; for (let k = 0; k < iv.length; k += 2) s += iv[k + 1] - iv[k]; return s; };
  function count(i, id) {
    if (isPath(id)) { const j = entry(i, pathByKey.get(id)); return j < 0 ? 0 : units[i].cnt[j]; }
    if (id === REST) return 0;
    return L.groups.get(id).members.reduce((s, m) => s + count(i, m), 0);
  }
  // Paths and the rest keep their times; a merged node's are worked out again when its members change.
  const msCache = new Map();
  function msOf(id) {
    const key = L.groups.has(id) ? `${id}|${L.groups.get(id).members.join(SEP)}` : id;
    if (!msCache.has(key)) {
      const out = new Float64Array(X.NU), p = isPath(id) ? pathByKey.get(id) : -1;
      for (let i = 0; i < X.NU; i++) {
        if (p < 0) { out[i] = lengthOf(intervals(i, id)) / 1000; continue; }
        const U = units[i], j = entry(i, p);
        if (j < 0) continue;
        for (let k = U.off[j]; k < U.off[j + 1]; k++) out[i] += (U.b[k] - U.a[k]) / 1000;
      }
      msCache.set(key, out);
    }
    return msCache.get(key);
  }
  // A child's average share of its parent's time, over the units that have the parent; and in how many it occurs.
  function shareIn(id, parent) {
    const c = msOf(id), p = parent === rootKey() ? null : msOf(parent);
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
  function collapse(id) { for (const d of descendants(id)) L.shown.delete(d); }
  // Opening a node shows its children that take a fair share of its time; with none, the largest.
  function expand(id) {
    const kids = kidsOfNode(id).map((k) => [k, shareIn(k, id).share]).sort((x, y) => y[1] - x[1]);
    const big = kids.filter(([, s]) => s >= BIG).slice(0, MAX_OPEN);
    for (const [k] of big.length ? big : kids.slice(0, 1)) L.shown.add(k);
  }
  function hide(id) { collapse(id); L.shown.delete(id); }
  // Shown, with whatever lies between it and the node it was added under.
  function add(ids, under) {
    for (const id of ids) for (let k = id; k !== null && k !== under && k !== rootKey(); k = parentOf(k)) L.shown.add(k);
  }
  // Several nodes as one, under the nearest path holding them all; a node inside another one picked goes with it.
  function merge(ids, name) {
    const pick = [...new Set(ids)].filter((id) => exists(id) && id !== rootKey());
    const members = pick.filter((x) => !pick.some((y) => y !== x && inside(x, y)));
    if (members.length < 2) { add(members, null); return members[0] || null; }
    for (const m of members) {
      const g = memberOf.get(m);
      if (!g) continue;
      const d = L.groups.get(g);
      d.members = d.members.filter((x) => x !== m);
      if (d.members.length < 2) ungroup(g);
    }
    const id = `g${L.next++}`;
    L.groups.set(id, { label: name || suggestName(members), members });
    relink();
    for (const m of members) hide(m);
    L.shown.add(id);
    for (let k = parentOf(id); k !== null && k !== rootKey(); k = parentOf(k)) L.shown.add(k);
    return id;
  }
  function ungroup(id) {
    const d = L.groups.get(id);
    if (!d) return;
    const was = shownOf(id);
    L.groups.delete(id);
    L.shown.delete(id);
    relink();
    if (was) for (const m of d.members) L.shown.add(m);
  }
  function rename(id, name) { if (L.groups.has(id) && name.trim()) L.groups.get(id).label = name.trim(); }
  // What a merged node is called before it is named: what its members' names begin with, else the first's and more.
  function suggestName(members) {
    const names = members.map(label);
    let pre = names[0];
    for (const s of names) while (!s.startsWith(pre)) pre = pre.slice(0, -1);
    pre = pre.replace(/[\s:,.(-]+$/, '');
    return pre.length >= 3 ? `${pre} (${names.length})` : `${names[0]} and ${names.length - 1} more`;
  }

  // What the + of a shown node offers: its children not shown, largest first; with a filter, anything not shown
  // inside it whose name has the text, with where it is.
  function candidates(under, query) {
    const q = (query || '').trim().toLowerCase(), out = [];
    const walk = (id, trail) => {
      for (const k of kidsOfNode(id)) {
        const shown = shownOf(k), name = label(k);
        if (!shown && (!q || name.toLowerCase().includes(q))) out.push({ id: k, label: name, where: trail.join(' › '), group: L.groups.has(k) });
        if (q) walk(k, [...trail, name]);
      }
    };
    walk(under, []);
    const rows = out.slice(0, 400).map((c) => Object.assign(c, shareIn(c.id, under)));
    return rows.sort((x, y) => y.share - x.share);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Applying what is shown: the columns, each unit's time in them, and each span's column.

  let ownerOf = new Int32Array(0), version = 0;
  const FAMILIES = 4;

  function frames(iv, total) {
    const G = X.GRID, grid = [];
    for (let k = 0; k < iv.length; k += 2) {
      const a = Math.floor(iv[k] * G / total), b = Math.max(a + 1, Math.ceil(iv[k + 1] * G / total));
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

  function apply() {
    const root = rootKey(), cols = [];
    const walk = (id, depth) => {
      for (const k of kidsOfNode(id)) {
        if (!L.shown.has(k)) continue;
        cols.push({ id: k, label: label(k), parent: id === root ? X.ROOT : id, depth, merged: L.groups.has(k) });
        walk(k, depth + 1);
      }
    };
    walk(root, 1);
    // Colours by the top-level column a column is under: the first FAMILIES in order, the rest in grey.
    let top = 0, family = 'other';
    for (const c of cols) {
      if (c.depth === 1) family = c.id === REST || top >= FAMILIES ? 'other' : `f${top++}`;
      c.family = family;
    }
    const NC = cols.length, at = new Map(cols.map((c, k) => [c.id, k]));
    data.columns = cols.map(({ id, label: l, parent, merged }) => ({ id, label: l, parent, merged }));
    data.partition = cols.map((c) => ({ id: c.id, label: c.label, family: c.family, from: [c.id] }))
      .concat([{ id: '~none', label: 'Under no violin', family: 'other', from: [] }]);
    // Which column counts a moment covered by several: the deepest shown, then the deepest in the call tree.
    const prio = cols.map((c, k) => k).sort((x, y) => cols[y].depth - cols[x].depth || callDepth(cols[y].id) - callDepth(cols[x].id));
    X.countFor = new Map();
    const repeats = new Uint8Array(NC);
    for (let i = 0; i < X.NU; i++) {
      const u = data.units[i], total = units[i].L;
      const s = new Float64Array(NC), fr = new Array(NC), c = new Int32Array(NC), p = new Float64Array(NC + 1), iv = new Array(NC);
      for (let k = 0; k < NC; k++) {
        iv[k] = intervals(i, cols[k].id);
        s[k] = lengthOf(iv[k]) / total;
        fr[k] = frames(iv[k], total);
        c[k] = count(i, cols[k].id);
        if (c[k] > 1) repeats[k] = 1;
      }
      let taken = [], owned = 0;
      for (const k of prio) {
        const piece = subtract(iv[k], taken);
        p[k] = lengthOf(piece) / total;
        owned += p[k];
        taken = mergeFlat(taken.concat(piece));
      }
      p[NC] = Math.max(0, 1 - owned);
      u.s = s; u.f = fr; u.c = c; u.p = p;
    }
    repeats.forEach((r, k) => { if (r) X.countFor.set(k, k); });
    // Each path's column: its own, or that of the nearest merged node or path above it that is shown.
    ownerOf = new Int32Array(paths.length).fill(-1);
    for (const P of paths) {
      let found = -1;
      for (let q = P.id; q >= 0 && found < 0; q = paths[q].parent) {
        if (at.has(paths[q].key)) { found = at.get(paths[q].key); break; }
        for (let g = memberOf.get(paths[q].key); g && found < 0; g = memberOf.get(g)) if (at.has(g)) found = at.get(g);
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
  // Keeping it: in the browser, for each kind of unit, by path, so it survives building the data again.

  const storeKey = () => `violinoscope.layout.${paths[rootPath].name}`;
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ shown: [...L.shown], next: L.next,
        groups: [...L.groups].map(([id, d]) => [id, d.label, d.members]) }));
    } catch (e) { /* storage off: the layout lasts as long as the page */ }
  }
  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (e) { saved = null; }
    if (!saved) return false;
    L.next = saved.next || 1;
    for (const [id, name, members] of saved.groups || []) {
      const ok = members.filter((m) => isPath(m) || m === REST || L.groups.has(m));
      if (ok.length >= 2) L.groups.set(id, { label: name, members: ok });
    }
    relink();
    for (const id of saved.shown || []) if (exists(id)) L.shown.add(id);
    return L.shown.size > 0;
  }

  function start() {
    ready = true;
    if (!meta.unit) X.UNIT = paths[rootPath].name;
    relink();
    if (!restore()) { L.shown.clear(); expand(rootKey()); }
    apply();
  }

  // ---------------------------------------------------------------------------------------------------------

  function change(f) { return (...args) => { const r = f(...args); relink(); apply(); X.render(); return r; }; }

  X.layout = {
    get ready() { return ready; },
    get version() { return version; },
    progress: () => [X.chunksLoaded(), X.chunkCount],
    rootKey: () => (ready ? rootKey() : null),
    label, inside, parentOf,
    candidates: (under, query) => candidates(under === X.ROOT ? rootKey() : under, query),
    kids: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id),
    shown: (id) => shownOf(id === X.ROOT ? rootKey() : id),
    isMerged: (id) => L.groups.has(id),
    members: (id) => (L.groups.has(id) ? L.groups.get(id).members.slice() : []),
    // Children shown, children there are, and the ones not shown.
    open: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id).some((k) => L.shown.has(k)),
    hidden: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id).filter((k) => !L.shown.has(k)).length,
    expand: change((id) => expand(id === X.ROOT ? rootKey() : id)),
    collapse: change((id) => collapse(id === X.ROOT ? rootKey() : id)),
    hide: change(hide),
    add: change((ids, under) => add(ids, under === X.ROOT ? rootKey() : under)),
    merge: change(merge),
    ungroup: change(ungroup),
    rename: change(rename),
    suggestName: (ids) => suggestName(ids),
    reset: change(() => { L.shown.clear(); L.groups.clear(); L.next = 1; relink(); expand(rootKey()); }),
    // The column a span counts toward, by its unit and row.
    partOfRow: (i, r) => (ready && units[i] ? ownerOf[units[i].rowPath[r]] : -1),
    partOfPath: (p) => (ready ? ownerOf[p] : -1),
    // Per path in a unit: the path, how many spans, their summed and self time in µs, for the spans table.
    pathsOf: (i) => units[i],
    path: (p) => paths[p],
  };
  X.on('chunk', indexChunk);
})();
