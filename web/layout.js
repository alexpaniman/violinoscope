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
  const Definitions = window.ViolinDefinitions;
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
  const L = { shown: new Set(), groups: new Map(), names: new Map(), top2: new Set(), open: new Set(), order: new Map(), parents: new Map(), except: new Map(), bounds: new Map(), skip: new Set(), next: 1, nextScope: 1 };
  L.retained = new Map();
  L.definitions = new Map();
  let activeSources = new Set();
  let memberOf = new Map(), sourceOwner = new Map(), in2 = new Set(), transfers = [];
  // Inputs are the recipe. `members` is a compatibility view for placement commands, never a second stored list.
  function definition(spec) {
    const d = {...spec, inputs:(spec.inputs || spec.members || []).map(Definitions.typedInput)};delete d.members;
    Object.defineProperty(d,'members',{get(){return this.inputs.map(Definitions.inputKey);},set(ids){
      this.inputs=ids.map(id=>this.inputs.find(input=>Definitions.inputKey(input)===id) || {violin:id});
    }});
    return d;
  }
  const definitionOf = id => L.groups.get(id) || L.definitions.get(id);
  const recipes = () => [...L.groups,...L.definitions];
  const inputsOf = id => definitionOf(id)?.inputs || (pathOf(id) >= 0 ? [{span:id}] : []);
  const restParts = id => id===REST ? [rootKey(),rootKey()] : Definitions.restParts(id);
  const isRest = id => !!restParts(id);
  const restsOf = id => inputsOf(id).filter(input=>input.span).map(input=>id===rootKey() ? REST : Definitions.rest(id,input.span));
  let definitionVersion = 0;
  const T2 = '\u0002', ROOT2 = X.ROOT2;

  const isPath = (id) => pathByKey.has(id);
  const isCopy = (id) => typeof id === 'string' && id[0] === T2 && pathByKey.has(Definitions.source(id));
  const copyOf = Definitions.copy;
  // A path or its copy: the path; else -1.
  const pathOf = (id) => (isPath(id) ? pathByKey.get(id) : isCopy(id) ? pathByKey.get(Definitions.source(id)) : -1);
  const scopeOf = id => isCopy(id) ? Definitions.scope(id) : L.groups.has(id) && L.groups.get(id).tree === 2 ? (L.groups.get(id).scope || '') : null;
  const newScope = () => String(L.nextScope++);
  const newGroup = () => {let id;do{id=`g${L.next++}`;}while(exists(id));return id;};
  function analysisOf(id) {
    if (treeOf(id) === 1) return 'main';
    let top = id;
    for (let p = callParent(top); p !== null && p !== ROOT2; p = callParent(top)) top = p;
    return top;
  }
  const exists = (id) => isPath(id) || isCopy(id) || L.groups.has(id) || (isRest(id) && inputsOf(restParts(id)[0]).some(input=>input.span===restParts(id)[1]));
  const rootKey = () => paths[rootPath].key;
  function recipeFlag(id,flag) {
    if(isRest(id))return recipeFlag(restParts(id)[0],flag);
    if(definitionOf(id))return inputsOf(id).some(input=>input.span ? !!paths[pathOf(input.span)]?.[flag] : recipeFlag(input.violin,flag));
    return pathOf(id)>=0 && !!paths[pathOf(id)][flag];
  }
  const independentOf=id=>recipeFlag(id,'independent'),flowOf=id=>recipeFlag(id,'flow'),dependencyOf=id=>recipeFlag(id,'dependency');
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
    if (definitionOf(id)) return inputsOf(id).some(input=>input.span ? rawInside(child,input.span) : contains(input.violin,child));
    return rawInside(child, id);
  }
  const isRoot = (id) => id === rootKey() || id === ROOT2;
  const treeOf = (id) => isRest(id) ? treeOf(restParts(id)[0]) : (id === ROOT2 || isCopy(id) || (L.groups.has(id) && L.groups.get(id).tree === 2) ? 2 : 1);
  function spanName(id) {
    const p = pathOf(id);
    if (p >= 0) return paths[p].name;
    if (isRest(id)) return `Rest of ${spanName(restParts(id)[1])}`;
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
    if (p >= 0 && !definitionOf(id)) return p;
    if (isRest(id)) return anchor(restParts(id)[0]);
    if (id === ROOT2) return rootPath;
    let lca = -1;
    for (const m of spansOf(id)) lca = lca < 0 ? pathOf(m) : common(lca,pathOf(m));
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
    if (isRest(id)) return callDepth(restParts(id)[0])+1;
    const parts = L.groups.get(id).members;
    return parts.length ? Math.min(...parts.map(callDepth)) : 0;
  }
  // Whether node x lies inside node y, in the same tree: under one of y's paths, or one of its members.
  function inside(x, y) {
    if (x === y) return true;
    if (treeOf(x) !== treeOf(y)) return false;
    if (definitionOf(y)) return inputsOf(y).some(input=>input.span ? rawInside(x,input.span) : inside(x,input.violin));
    if (isRest(y) || isRest(x)) return false;
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
    if(isRest(id))return restParts(id)[0];
    if (memberOf.has(id)) return memberOf.get(id);
    if (L.parents.has(id)) return L.parents.get(id);
    if (pathOf(id) >= 0) {
      const P = paths[pathOf(id)];
      if (P.independent && (!paths[P.parent] || !paths[P.parent].independent)) return isCopy(id) ? ROOT2 : null;
      let p = P.parent;
      if (p >= 0 && L.except.size) {
        let up = isCopy(id) ? copyOf(paths[p].key, scopeOf(id)) : paths[p].key;
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
      const up = p >= 0 ? copyOf(paths[p].key, scopeOf(id)) : null;
      return in2.has(up) ? up : null;
    }
    if (id === REST) return rootKey();
    if (!L.groups.has(id)) return null;
    if (L.groups.get(id).parent) return L.groups.get(id).parent;
    const ap = anchor(id), direct = spansOf(id).some((m) => pathOf(m) === ap);
    const a = paths[direct && paths[ap].parent >= 0 ? paths[ap].parent : ap].key;
    if (L.groups.get(id).tree !== 2) return a;
    const up = copyOf(a, scopeOf(id));
    return in2.has(up) ? up : ROOT2;
  }
  // Every node's children, shown or not; built again whenever what is merged changes.
  let kidsOf = new Map(), modelKids = new Map();
  let definitionKey = '';
  function relink() {
    parentCache = new Map();
    const key = JSON.stringify([paths.length, [...activeSources], recipes().map(([g, d]) => [g, d.inputs, d.tree, d.scope, d.parent]), [...L.parents], [...L.except], [...L.bounds], [...L.retained], [...L.top2]]);
    if (key !== definitionKey) { definitionKey = key; definitionVersion++; coverageCache.clear(); sourceTransferCache.clear(); baseCache.clear(); msCache.clear(); nodeCache.clear(); }
    // Where a span shows: in the deepest merged node it is in.
    memberOf = new Map(); sourceOwner = new Map();
    const level = (g) => { let n = 0; for (let q = L.groups.get(g).parent; q && L.groups.has(q); q = L.groups.get(q).parent) n++; return n; };
    for (const g of [...L.groups.keys()].sort((x, y) => level(x) - level(y))) for (const m of L.groups.get(g).members) memberOf.set(m, g);
    for (const [g,d] of L.definitions) for (const m of d.members) if(m!==g)memberOf.set(m,g);
    for (const [g,d] of recipes()) for (const input of d.inputs) if (input.span && input.span!==g) sourceOwner.set(input.span,g);
    // The paths in the second tree: those put there or merged there, and every path under them.
    in2 = new Set();
    const grow = (p, scope = '') => { const id = copyOf(paths[p].key, scope); if (in2.has(id)) return; in2.add(id); for (const q of paths[p].kids) grow(q, scope); };
    for (const id of L.top2) grow(pathOf(id), scopeOf(id));
    for (const P of paths) if (P.independent && (!paths[P.parent] || !paths[P.parent].independent)) grow(P.id);
    for (const [id,d] of recipes()) if (treeOf(id) === 2) for (const m of d.members) if (isCopy(m)) grow(pathOf(m), scopeOf(m));
    transfers = [...new Set([...memberOf.keys(), ...L.parents.keys(), ...L.top2])];
    kidsOf = new Map(); modelKids = new Map();
    const add = (id) => {
      const model = callParent(id), display = parentOf(id);
      if (model !== null) (modelKids.get(model) || modelKids.set(model, []).get(model)).push(id);
      if (display !== null && !L.skip.has(id)) (kidsOf.get(display) || kidsOf.set(display, []).get(display)).push(id);
    };
    for (const P of paths) if (P.id !== rootPath && !P.independent && (P.n || activeSources.has(P.key))) add(P.key);
    for (const id of in2) add(id);
    for (const g of L.groups.keys()) add(g);
    for(const id of [...paths.filter(p=>!p.independent && (p.n || activeSources.has(p.key))).map(p=>p.key),...in2,...L.groups.keys()])for(const rest of restsOf(id))add(rest);
    for (const [p, list] of kidsOf) {
      const order = L.order.get(p) || [], at = (x) => { const k = order.indexOf(x); return k < 0 ? Infinity : k; };
      list.sort((x, y) => at(x) - at(y) || startOf(x) - startOf(y));
    }
  }
  // When a node usually starts in a unit, as a share of it, so children read in the order they run.
  function startOf(id) {
    const p = pathOf(id);
    if (p >= 0) { const P = paths[p]; return P.n ? P.start / P.n : 1; }
    if (isRest(id)) return 2;
    const parts = L.groups.get(id).members;
    return parts.length ? Math.min(...parts.map(startOf)) : 2;
  }
  const kidsOfNode = (id) => kidsOf.get(id) || [];
  const modelChildren = (id) => modelKids.get(id) || [];
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
    if (isRest(id)) {
      const [owner,source]=restParts(id);
      let iv=intersection(inputIntervals(i,owner,inputsOf(owner).find(input=>input.span===source)),intervals(i,owner));
      const earlier=inputsOf(owner).filter(input=>input.span && Definitions.compare(input.span,source)<0);
      for(const input of earlier)iv=subtract(iv,inputIntervals(i,owner,input));
      const children=new Set(modelChildren(owner));
      for(const child of children)if(!isRest(child) && child!==owner)iv=subtract(iv,intervals(i,child));
      return iv;
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
    const d = {inputs: definitionOf(id)?.inputs, transferred: [], excluded: [], bounds: [], retained:[], parents: [], clipParents: []};
    if (pathOf(id) >= 0 && !independentOf(id)) d.transferred = transfers.filter((m) =>
      pathOf(m) >= 0 && m !== id && scopeOf(m) === scopeOf(id) && inside(m, id) && !inside(id, m) && !structuralInside(m, id) && !independentOf(m));
    let child = id;
    for (let p = id; p !== null && p !== ROOT2; child = p, p = callParent(p)) {
      d.excluded.push(...(L.except.get(p) || []));
      d.bounds.push(...(L.bounds.get(p) || []));
      d.retained.push(...(L.retained.get(p) || []));
      if(p!==id)d.retained.push(...(inputsOf(p).find(input=>Definitions.inputKey(input)===child)?.cuts || []));
      if (p !== id) d.parents.push(p);
      if (p !== id && !isRoot(p) && (!definitionOf(p) || memberOf.get(child) !== p || sourceOwner.get(child) === p)) d.clipParents.push(p);
    }
    coverageCache.set(id, d);
    return d;
  }
  const baseCache = new Map(), EMPTY = Object.freeze([]);
  function baseIntervals(i, id) {
    let values = baseCache.get(id);
    if (!values) { values = new Array(X.NU); baseCache.set(id, values); }
    if (values[i] !== undefined) return values[i];
    const d = coverageOf(id);
    let iv = d.inputs ? d.inputs.reduce((a,input)=>unite(a,inputIntervals(i,id,input)),[]) : raw(i,id);
    for (const bound of d.bounds) iv = intersection(iv, raw(i, bound));
    // A path loses only the effective coverage extracted outside its structural ancestry.
    for (const m of d.transferred) iv = subtract(iv, claimedIntervals(i, m));
    for (const cut of d.retained) iv = subtract(iv, expressionIntervals(i, cut));
    for (const m of d.excluded) iv = subtract(iv, raw(i, m));
    return (values[i] = iv.length ? iv : EMPTY);
  }
  // Resolve recipe/transfer coverage first, then apply the containing context. Keeping these two stages
  // separate avoids a cycle when A is extracted while a descendant of A is intentionally left behind.
  function intervals(i, id) {
    let iv = baseIntervals(i, id);
    for (const parent of coverageOf(id).clipParents) {
      if (!iv.length) break;
      iv = intersection(iv, baseIntervals(i, parent));
    }
    return iv;
  }
  const covered = raw;
  const sourceTransferCache=new Map();
  function sourceTransfers(source,owner) {
    const key=JSON.stringify([source,owner]);if(sourceTransferCache.has(key))return sourceTransferCache.get(key);
    const result=transfers.filter(m=>pathOf(m)>=0 && m!==source && scopeOf(m)===scopeOf(source) && rawInside(m,source) && !structuralInside(m,owner) && !structuralInside(owner,m) && !independentOf(m));
    sourceTransferCache.set(key,result);return result;
  }
  function sourceInputIntervals(i, source, owner=source) {
    let iv=raw(i,source);
    for(const m of sourceTransfers(source,owner))iv=subtract(iv,claimedIntervals(i,m));
    return iv;
  }
  function inputIntervals(i,owner,input) {
    let iv=input.span ? sourceInputIntervals(i,input.span,owner) : baseIntervals(i,input.violin);
    for(const cut of input.cuts || [])iv=subtract(iv,expressionIntervals(i,cut));
    return iv;
  }
  function claimedIntervals(i, id) {
    const owner=sourceOwner.get(id);if(!owner)return baseIntervals(i,id);
    let iv=inputIntervals(i,owner,inputsOf(owner).find(input=>input.span===id)),d=coverageOf(owner);
    for(const bound of d.bounds)iv=intersection(iv,raw(i,bound));
    for(const excluded of d.excluded)iv=subtract(iv,raw(i,excluded));
    for(const cut of d.retained)iv=subtract(iv,expressionIntervals(i,cut));
    return iv;
  }
  // Copied transfers are value definitions, not links back into another analysis. Their interval recipes
  // retain edited holes without storing per-dataset numbers or changing when the original is edited later.
  function freezeBase(id) {
    const d = coverageOf(id);
    let expression = d.inputs ? ['union', ...d.inputs.map(input=>freezeInput(id,input))] : ['span',id];
    for (const bound of d.bounds) expression = ['intersect', expression, ['span',bound]];
    for (const member of d.transferred) expression = ['subtract', expression, freezeClaim(member)];
    for (const cut of d.retained) expression = ['subtract',expression,cut];
    for (const excluded of d.excluded) expression = ['subtract',expression,['span',excluded]];
    return expression;
  }
  function freezeSource(id,owner=id) {
    let expression=['span',id];
    for(const m of sourceTransfers(id,owner))expression=['subtract',expression,freezeClaim(m)];
    return expression;
  }
  function freezeInput(owner,input) {
    let expression=input.span ? freezeSource(input.span,owner) : freezeBase(input.violin);
    for(const cut of input.cuts || [])expression=['subtract',expression,cut];
    return expression;
  }
  function freezeClaim(id) {
    const owner=sourceOwner.get(id);if(!owner)return freezeBase(id);
    let expression=freezeInput(owner,inputsOf(owner).find(input=>input.span===id)),d=coverageOf(owner);
    for(const bound of d.bounds)expression=['intersect',expression,['span',bound]];
    for(const excluded of d.excluded)expression=['subtract',expression,['span',excluded]];
    for(const cut of d.retained)expression=['subtract',expression,cut];
    return expression;
  }
  function expressionIntervals(i, expression) {
    const [op, ...args] = expression;
    if (op === 'span') return raw(i,args[0]);
    if (op === 'union') return args.reduce((iv,arg) => unite(iv,expressionIntervals(i,arg)),[]);
    const a = expressionIntervals(i,args[0]), b = expressionIntervals(i,args[1]);
    return op === 'subtract' ? subtract(a,b) : intersection(a,b);
  }
  const lengthOf = (iv) => { let s = 0; for (let k = 0; k < iv.length; k += 2) s += iv[k + 1] - iv[k]; return s; };
  function count(i, id) {
    if(definitionOf(id))return inputsOf(id).reduce((sum,input)=>{
      if(input.violin)return sum+count(i,input.violin);
      const j=entry(i,pathOf(input.span));return sum+(j<0?0:units[i].cnt[j]);
    },0);
    if (pathOf(id) >= 0) { const j = entry(i, pathOf(id)); return j < 0 ? 0 : units[i].cnt[j]; }
    if (isRest(id)) return 0;
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

  function descendants(id, out = []) { for (const k of modelChildren(id)) { out.push(k); descendants(k, out); } return out; }
  // Closed: what is under it waits, shown or open as it was, for when it opens again.
  function collapse(id) { L.open.delete(id); }
  // Opening a node shows what was shown under it before; the first time, its children that take a fair share of its
  // time, or with none, the largest. It stays open with all of them hidden.
  function expand(id) {
    L.open.add(id);
    if (!kidsOfNode(id).some((k) => L.shown.has(k))) for (const k of largest(kidsOfNode(id), id)) L.shown.add(k);
  }
  function largest(list, of) {
    const kids = list.filter(k=>!isRest(k)).map((k) => [k, shareIn(k, of).share]).sort((x, y) => y[1] - x[1]);
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
  // Definitions survive hiding and becoming empty. Only explicit dissolution removes a definition.
  function drop(g) {
    unshow(g);
    L.groups.delete(g); L.except.delete(g); L.bounds.delete(g); L.retained.delete(g); L.names.delete(g); L.order.delete(g); L.parents.delete(g);
    for (const list of L.order.values()) { const k = list.indexOf(g); if (k >= 0) list.splice(k, 1); }
  }
  function prune() {
    for (const [,d] of recipes()) d.members = [...new Set(d.members)].filter(exists);
    for (const [id, p] of L.parents) if (!exists(id) || (!exists(p) && p !== ROOT2)) L.parents.delete(id);
    for (const [id, list] of L.order) {
      if (!exists(id) && id !== ROOT2) L.order.delete(id);
      else L.order.set(id, list.filter(exists));
    }
    for (const map of [L.except,L.bounds,L.retained,L.names]) for (const id of map.keys()) if (!exists(id)) map.delete(id);
    for(const set of [L.shown,L.open,L.skip])for(const id of set)if(!exists(id))set.delete(id);
  }
  // Removed: its parent still counts it; put at the top of the second tree, it leaves it; merged, it goes. A span
  // open with children shown leaves just its level: they move up to its parent, which holds them as it held it.
  const lifts = (id) => isOpen(id) && kidsOfNode(id).some((k) => L.shown.has(k));
  function hide(id) {
    if (isRoot(id) || !exists(id)) return;
    if (!isOpen(id)) unshow(id);
    L.skip.add(id);
    L.shown.delete(id); L.open.delete(id);
    relink();
  }
  // Left out of a node's time: spans inside it; put back, one at a time.
  function exclude(id, spans) {
    if (isRoot(id)) return;
    const list = L.except.get(id) || [];
    for (const m of spans) {
      if (m === id || !exists(m) || !contains(id, m) || (treeOf(id) === 1 && independentOf(m))) continue;
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
    if (under && under !== ROOT2 && treeOf(under) === 2) ids = ids.map(id => isCopy(id) && scopeOf(id) === ''
      ? spansOf(under).find(m => Definitions.source(m) === Definitions.source(id)) || copyOf(Definitions.source(id), scopeOf(under)) : id);
    if (under === ROOT2) ids = ids.map(id => isCopy(id) && scopeOf(id) === '' && !independentOf(id) ? duplicate(id, 2, false) : id);
    for (const id of ids) if (under === ROOT2 && isCopy(id) && !in2.has(id)) L.top2.add(id);
    // Added back where it was taken out from between, it holds its children again.
    for (const id of ids) L.skip.delete(id);
    relink();
    for (const id of ids) showUp(id, under);
  }
  // Shown, with every node above it shown and open, up to `stop`.
  function showUp(id, stop) {
    for (let k = id; k !== null && k !== stop && !isRoot(k); k = parentOf(k)) {
      if (k === id) L.skip.delete(k);
      L.shown.add(k);
      const p = parentOf(k);
      if (p !== null && !isRoot(p)) L.open.add(p);
    }
  }
  // A node's spans: its own, or a merged node's members.
  const spansOf = id => inputsOf(id).flatMap(input=>input.span?[input.span]:spansOf(input.violin));
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
    for (const [g, d] of recipes()) if (g !== keep) d.members = d.members.filter((x) => x===g || !list.includes(x));
    for (const m of list) { L.top2.delete(m); L.parents.delete(m); }
  }
  // A move preserves the selected definition, including cuts inherited from a level it leaves.
  // Ownership transfers remain derived; only real exclusions are carried into the moved part.
  function retainContext(ids) {
    const contexts = ids.map(id => {
      const parents = [];let child=id;
      for (let p = callParent(id); p !== null && p !== ROOT2; child=p,p = callParent(p)) parents.push({
        id:p, excluded:(L.except.get(p) || []).slice(),
        retained:[...(L.retained.get(p) || []),...(inputsOf(p).find(input=>Definitions.inputKey(input)===child)?.cuts || [])],
        bounds:[...(L.bounds.get(p) || []), ...(pathOf(p) >= 0 && !isRoot(p) ? [p] : [])]
      });
      return {id, parents};
    });
    return () => {
      for (const {id, parents} of contexts) for (const parent of parents) if (!structuralInside(id,parent.id)) {
        if (parent.excluded.length) L.except.set(id,[...new Set([...(L.except.get(id) || []),...parent.excluded])]);
        if (parent.bounds.length) L.bounds.set(id,[...new Set([...(L.bounds.get(id) || []),...parent.bounds])]);
        if (parent.retained.length) L.retained.set(id,[...(L.retained.get(id) || []),...parent.retained]);
      }
      relink();
    };
  }
  function commonParent(ids) {
    for (let p = callParent(ids[0]); p !== null; p = callParent(p)) if (ids.every(id => id !== p && structuralInside(id,p))) return p;
    return treeOf(ids[0]) === 2 ? ROOT2 : rootKey();
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
  const canMerge = (x, y) => exists(x) && exists(y) && x !== y && !isRest(x) && !isRest(y) && !isRoot(x) && !isRoot(y) && treeOf(x) === treeOf(y) && !structuralInside(x, y) && !structuralInside(y, x) && (treeOf(x) === 2 || (!independentOf(x) && !independentOf(y)));
  // Compose the picked definitions as parts, retaining exclusions, names and nested operands. A group made
  // inside another replaces those memberships with one reference to the new group.
  function merge(ids, name, match, keep = true) {
    if (ids.length && ids.every(id => isCopy(id) && scopeOf(id) === '')) {
      const scope = newScope(); ids = ids.map(id => duplicate(id, 2, false, scope));
    }
    const pick = [...new Set(ids)].filter((id) => exists(id) && !isRoot(id) && !isRest(id));
    const tree = pick.length ? treeOf(pick[0]) : 1;
    const picked = pick.filter((x) => treeOf(x) === tree && (tree === 2 || !independentOf(x)));
    const members = picked.filter((x) => !picked.some((y) => x !== y && structuralInside(x, y)));
    if (members.length < 2) { add(members, tree === 2 ? ROOT2 : null); return members[0] || null; }
    const home = commonParent(members), seen = new Set(keep ? members.filter(shownOf) : []), retain = retainContext(members);
    const id = newGroup();
    free(members, null);
    const scopes = [...new Set(members.map(scopeOf))];
    L.groups.set(id, definition(Object.assign({ label: name || suggestName(members), members }, tree === 2 ? { tree, scope: scopes.length === 1 ? scopes[0] : id } : {}, match ? { match } : {})));
    if (definitionOf(home)) definitionOf(home).members = [...definitionOf(home).members,id];
    else L.parents.set(id, home);
    relink();
    retain();
    for (const m of members) if (!seen.has(m)) unshow(m);
    if (seen.size) L.open.add(id);
    showUp(id);
    return id;
  }
  // The nearest span holding all of several nodes, when it is off screen (taken out from above them), to put back.
  function dominator(ids) {
    const list = ids.filter((id) => exists(id) && !isRoot(id));
    if (list.length < 2 || list.some((id) => treeOf(id) !== treeOf(list[0]))) return null;
    let lca = -1;
    for (const id of list) lca = lca < 0 ? anchor(id) : common(lca, anchor(id));
    if (lca < 0 || lca === rootPath) return null;
    const span = treeOf(list[0]) === 2 ? copyOf(paths[lca].key, scopeOf(list[0])) : paths[lca].key;
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
    const parent = callParent(into);
    if (parent && !isRoot(parent) && !contains(parent,id)) return null;
    const retain = retainContext([id]); free([id], null);
    L.groups.get(into).members = [...L.groups.get(into).members,id];
    relink(); retain(); showUp(into);
    return into;
  }
  // Remove a direct part from a definition and return it to the surrounding composition or its call ancestry.
  function leave(id, from) {
    const g = from || memberOf.get(id), d = definitionOf(g);
    if (!d || !d.members.includes(id)) return;
    const retain = retainContext([id]);
    d.members = d.members.filter((x) => x !== id);
    delete d.match;
    relink();
    retain();
    if (isCopy(id) && parentOf(id) === null) { L.top2.add(id); relink(); }
    showUp(id);
  }
  // A merged node split up: its spans go where they belong, a copy left nowhere to the top of the second tree. Shown,
  // it leaves its larger spans shown, as opening it would, and the rest behind the + of where they go.
  function ungroup(id) {
    const d = L.groups.get(id);
    if (!d) return;
    // A constrained union cannot be flattened without changing raw source inputs or cutting sibling inputs.
    // Keep its recipe and lift the display level instead; it remains available through + and breadcrumbs.
    if (constrained(id)) {
      L.skip.add(id);L.shown.delete(id);L.open.delete(id);relink();
      for(const member of d.members)showUp(member);
      return;
    }
    const keep = shownOf(id) ? largest(d.members, id) : [];
    const parent = memberOf.get(id), retain = retainContext(d.members);
    if (parent) definitionOf(parent).inputs = inputsOf(parent).flatMap(input => input.violin===id ? d.inputs.map(Definitions.typedInput) : [input]);
    for (const m of d.members) if (L.except.has(id)) L.except.set(m, [...new Set([...(L.except.get(m) || []), ...L.except.get(id)])]);
    drop(id);
    relink();
    retain();
    for (const m of d.members) if (isCopy(m) && parentOf(m) === null) L.top2.add(m);
    relink();
    for (const m of keep) showUp(m);
  }
  const constrained=id=>[L.except,L.bounds,L.retained].some(map=>map.get(id)?.length);
  // A node of the first tree copied to the top of the second: a path as its copy, a merged node with its members.
  function moveClosure(id) {
    const tree=treeOf(id);
    return [...new Set((tree===2 ? [...in2,id] : paths.map(p=>p.key)).concat([...L.groups.keys(),...L.definitions.keys()]))]
      .filter(x=>treeOf(x)===tree && structuralInside(x,id));
  }
  function transferProblem(id) {
    if(treeOf(id)!==2 || independentOf(id))return '';
    const sources=moveClosure(id).filter(x=>pathOf(x)>=0).map(Definitions.source);
    return new Set(sources).size!==sources.length ? 'Contains independent copies of the same span. Remove a copy before moving into the main tree.' : '';
  }
  function duplicate(id, tree, remove, targetScope, preserveGroups = false) {
    const inherited = coverageOf(id);
    if (tree === 2 && targetScope === undefined) targetScope = newScope();
    const mapping = new Map(), source = state(), sourceTree = treeOf(id);
    const scope = moveClosure(id);
    const frozenCuts = new Map(scope.concat(id).map(x => [x, [
      ...(L.retained.get(x) || []), ...coverageOf(x).transferred.map(freezeClaim)
    ]]));
    const frozenInputs=new Map(scope.concat(id).map(x=>[x,inputsOf(x).map(input=>({
      ...input,...(input.span && sourceTransfers(input.span,x).length ? {cuts:[...(input.cuts || []),...sourceTransfers(input.span,x).map(freezeClaim)]} : {})
    }))]));
    const dup = (x) => {
      if (mapping.has(x)) return mapping.get(x);
      if(isRest(x)) {const [owner,source]=restParts(x),out=Definitions.rest(dup(owner),dup(source));mapping.set(x,out);return out;}
      const p = pathOf(x), y = p >= 0 ? (tree === 2 ? copyOf(paths[p].key, targetScope) : paths[p].key) : preserveGroups && remove ? x : newGroup();
      mapping.set(x, y);
      if (L.groups.has(x)) {
        const d = L.groups.get(x);
        L.groups.set(y, definition({ label: d.label, inputs:frozenInputs.get(x).map(input=>({...input,...(input.span ? {span:dup(input.span)} : {violin:dup(input.violin)})})), ...(tree === 2 ? { tree: 2, scope: targetScope } : {}) }));
      }
      if (L.definitions.has(x)) L.definitions.set(y,definition({inputs:frozenInputs.get(x).map(input=>({...input,...(input.span ? {span:dup(input.span)} : {violin:dup(input.violin)})}))}));
      else if(p>=0)L.definitions.delete(y);
      return y;
    };
    const out = dup(id);
    for (const x of scope) dup(x);
    for(const x of new Set([...source.shown,...source.open,...source.skip,...source.names.map(([id])=>id)]))if(isRest(x)&&mapping.has(restParts(x)[0]))dup(x);
    const targets = new Set(mapping.values()), freshGroups = new Set([...targets].filter((m) => L.groups.has(m)));
    for (const [g, d] of recipes()) if (!targets.has(g) && treeOf(g) === tree) d.members = d.members.filter((m) => m===g || !targets.has(m));
    const names = new Map(source.names), exclusions = new Map(source.except), bounds = new Map(source.bounds), orders = new Map(source.order), parents = new Map(source.parents);
    for (const [x, y] of mapping) {
      L.shown.delete(y); L.open.delete(y); L.skip.delete(y); L.parents.delete(y); L.top2.delete(y); L.names.delete(y); L.except.delete(y); L.bounds.delete(y); L.retained.delete(y); L.order.delete(y);
      if (source.shown.includes(x)) L.shown.add(y);
      if (source.open.includes(x)) L.open.add(y);
      if (source.skip.includes(x)) L.skip.add(y);
      if (names.has(x)) L.names.set(y, names.get(x));
      if (exclusions.has(x)) L.except.set(y, exclusions.get(x).map((m) => tree === 2 ? copyOf(paths[pathOf(m)].key, targetScope) : paths[pathOf(m)].key));
      if (bounds.has(x)) L.bounds.set(y, bounds.get(x));
      if (frozenCuts.get(x)?.length) L.retained.set(y, frozenCuts.get(x));
      if (orders.has(x)) L.order.set(y, orders.get(x).filter((m) => mapping.has(m)).map((m) => mapping.get(m)));
      if (mapping.has(parents.get(x))) L.parents.set(y, mapping.get(parents.get(x)));
      if (remove && x !== y) { L.shown.delete(x); L.open.delete(x); L.skip.delete(x); L.groups.delete(x); L.definitions.delete(x); L.except.delete(x); L.bounds.delete(x); L.retained.delete(x); L.names.delete(x); L.order.delete(x); L.parents.delete(x); L.top2.delete(x); }
    }
    if (remove) for (const [g,d] of recipes()) if (!targets.has(g)) d.members = d.members.filter(m => m===g || !mapping.has(m));
    if (inherited.excluded.length) L.except.set(out,[...new Set([...(L.except.get(out) || []),...inherited.excluded])]);
    if (inherited.retained.length) L.retained.set(out,[...new Set([...(L.retained.get(out) || []),...inherited.retained])]);
    const contextBounds = [...inherited.bounds,...inherited.parents.filter(p => pathOf(p) >= 0 && !isRoot(p))];
    if (contextBounds.length) L.bounds.set(out,[...new Set([...(L.bounds.get(out) || []),...contextBounds])]);
    if (remove && X.S?.factors) for (const [x,y] of mapping) if (x !== y && X.S.factors.has(x)) {
      const factor = X.S.factors.get(x); X.S.factors.delete(x); X.S.factors.set(y,factor);
    }
    return out;
  }
  function copyOver(id) {
    if (treeOf(id) !== 1 || isRoot(id) || isRest(id) || !exists(id)) return null;
    const c = duplicate(id, 2, false);
    if (isCopy(c)) L.top2.add(c);
    relink(); showUp(c);
    return c;
  }
  function destinations(id) {
    if (!exists(id) || isRoot(id) || isRest(id)) return [];
    if (treeOf(id) === 1) return [{ id: ROOT2, label: 'Projections' }];
    if (independentOf(id)) return [];
    if(transferProblem(id))return [];
    const spans = spansOf(id).map((m) => paths[pathOf(m)].key);
    if (new Set(spans).size !== spans.length) return [];
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
    const tree = target === ROOT2 ? 2 : 1, out = duplicate(id, tree, true, undefined, true);
    if (target === ROOT2 && isCopy(out)) L.top2.add(out);
    else if (L.groups.has(target)) L.groups.get(target).members = [...L.groups.get(target).members,out];
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
  // Replace one recipe input explicitly. A source reads the recording; a violin follows its edited recipe.
  // The replaced definition survives and is returned to its natural placement when the new input differs.
  function replaceInput(owner, index, input) {
    if (isRoot(owner) || !exists(owner)) throw Error('The unit source is fixed');
    const id=Definitions.inputKey(input),previous=inputsOf(owner)[index];
    if (index<0 || index>inputsOf(owner).length || !exists(id) || isRoot(id) || isRest(id) || (input.span && pathOf(id)<0)) throw Error('Choose a span or violin input');
    if (treeOf(id)!==treeOf(owner)) throw Error('Choose an input from this analysis');
    if(treeOf(owner)===1 && (input.span ? paths[pathOf(id)].independent : independentOf(id)))throw Error('Independent async work belongs in Projections');
    if (input.violin && (id===owner || structuralInside(owner,id))) throw Error('A violin cannot depend on itself or an ancestor');
    const parent=callParent(owner);
    if (parent && parent!==ROOT2 && !isRoot(parent) && !contains(parent,id)) throw Error('The input must be inside the containing violin');
    const old=Definitions.inputKey(previous);
    const retainChildren=retainContext(modelChildren(owner).filter(id=>!isRest(id)));
    if(inputsOf(owner).some((v,k)=>k!==index && Definitions.inputKey(v)===id))throw Error('This input is already included');
    if(id!==old) {
      if(id!==owner && structuralInside(owner,id))throw Error('The input cannot contain its own violin');
      const retain=retainContext([id]);free([id],owner);
      if(!definitionOf(owner))L.definitions.set(owner,definition({inputs:inputsOf(owner)}));
      definitionOf(owner).inputs[index]=Definitions.typedInput(input);relink();retain();
      if(isCopy(old) && parentOf(old)===null){L.top2.add(old);relink();}
    } else {
      if(!definitionOf(owner))L.definitions.set(owner,definition({inputs:inputsOf(owner)}));
      definitionOf(owner).inputs[index]=Definitions.typedInput(input);
    }
    delete definitionOf(owner).match;
    relink();releaseUnsupported(owner);retainChildren();
  }
  const sourceTerms=spansOf;
  function supports(owner,child) {
    const sources=sourceTerms(owner);
    return sourceTerms(child).every(term=>sources.some(source=>rawInside(term,source)));
  }
  function releaseUnsupported(owner) {
    for(const child of modelChildren(owner).slice())if(!isRest(child) && L.parents.has(child) && !supports(owner,child)) {
      let parent=callParent(owner);
      while(parent!==null && parent!==ROOT2 && !isRoot(parent) && !supports(parent,child))parent=callParent(parent);
      if(parent===ROOT2 && isCopy(child)){L.top2.add(child);L.parents.delete(child);}
      else L.parents.set(child,parent || (treeOf(child)===2?ROOT2:rootKey()));
    }
    relink();
  }
  function removeInput(owner,index) {
    if(isRoot(owner))return;
    const inputs=inputsOf(owner),old=inputs[index];if(!old)return;
    const id=Definitions.inputKey(old),retain=retainContext([...new Set([...(id!==owner?[id]:[]),...modelChildren(owner).filter(id=>!isRest(id))])]);
    if(!definitionOf(owner))L.definitions.set(owner,definition({inputs}));
    definitionOf(owner).inputs=inputs.filter((_,k)=>k!==index);delete definitionOf(owner).match;
    relink();releaseUnsupported(owner);retain();
    if(id!==owner && isCopy(id) && parentOf(id)===null)L.top2.add(id);
  }
  function inputChoices(owner,type,query='') {
    const q=query.trim().toLowerCase(),tree=treeOf(owner),parent=callParent(owner);
    const ids=type==='span' ? paths.filter(p=>p.n || activeSources.has(p.key)).map(p=>tree===2 ? copyOf(p.key,scopeOf(owner)) : p.key)
      : [...paths.filter(p=>p.n || activeSources.has(p.key)).map(p=>p.key),...in2,...L.groups.keys()];
    return ids.filter(id=>treeOf(id)===tree && !isRoot(id) && id!==REST && (type==='span' || (id!==owner && !structuralInside(owner,id))))
      .filter(id=>tree===2 || !(type==='span' ? paths[pathOf(id)]?.independent : independentOf(id)))
      .filter(id=>!parent || parent===ROOT2 || isRoot(parent) || contains(parent,id))
      .filter(id=>type==='span' || tree===1 || analysisOf(id)===analysisOf(owner))
      .filter(id=>!q || (type==='span' ? spanName(id) : label(id)).toLowerCase().includes(q))
      .map(id=>({id,label:type==='span' ? spanName(id) : label(id),where:Definitions.source(id).split(SEP).slice(0,-1).join(' › ')})).slice(0,400);
  }
  function previewInput(owner,index,input) {
    const saved=JSON.parse(JSON.stringify(state())),before=msOf(owner).slice();
    try {replaceInput(owner,index,input);relink();Definitions.validate(rootKey(),state());return {before,after:msOf(owner).slice()};}
    finally {load(saved,true);relink();}
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
      for (const k of modelChildren(id)) {
        offer(k, label(k), trail, deep);
        walk(k, [...trail, label(k)], true);
      }
    };
    const anywhere = (p, trail, deep) => {
      for (const c of paths[p].kids) {
        if(!paths[c].n && !activeSources.has(paths[c].key))continue;
        offer(copyOf(paths[c].key), label(copyOf(paths[c].key)), trail, deep);
        anywhere(c, [...trail, paths[c].name], true);
      }
    };
    if (under === ROOT2) {
      anywhere(rootPath, [], false);
      for (const k of modelChildren(ROOT2)) if (L.groups.has(k)) offer(k, label(k), [], false);
    } else walk(under, [], false);
    const rows = out.slice(0, 400).map((c) => Object.assign(c, shareIn(c.id, under)));
    return rows.sort((x, y) => x.deep - y.deep || y.share - x.share);
  }

  // For a node's card: spans anywhere in its tree to put into its time, or spans inside it to leave out, the
  // filter typed; untyped, its own children for leaving out, nothing to put in.
  function spansFor(id, query, mode) {
    const q = (query || '').trim().toLowerCase(), out = [], tree = treeOf(id), less = L.except.get(id) || [];
    const found = (s) => s && s.toLowerCase().includes(q);
    const idOf = (p) => (tree === 2 ? copyOf(paths[p].key, scopeOf(id)) : paths[p].key);
    const walk = (p, trail) => {
      for (const c of paths[p].kids) {
        const k = idOf(c), name = paths[c].name, within = inside(k, id) && k !== id;
        const fits = mode === 'exclude' ? within && contains(id, k) && !less.some((m) => rawInside(k, m)) && !transfers.some((m) => m !== id && treeOf(m) === tree && inside(k, m) && inside(m, id) && !structuralInside(m, id))
          : !within && k !== id && !inside(id, k);
        const container=callParent(id);
        if (fits && (mode !== 'include' || !L.groups.has(id) || !container || isRoot(container) || contains(container,k)) && (q ? found(name) : spansOf(id).includes(idOf(p)))) out.push({ id: k, label: name, where: trail.join(' › '), group: false });
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
    if (nodeCache.size > Math.max(64,data.columns?.length || 0)) nodeCache.delete(nodeCache.keys().next().value);
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
  function intersection(a, b) {
    const out = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i], b[j]), hi = Math.min(a[i + 1], b[j + 1]);
      if (hi > lo) out.push(lo, hi);
      if (a[i + 1] < b[j + 1]) i += 2; else j += 2;
    }
    return out;
  }
  function outside(taken, total) {
    const out = [];
    let at = 0;
    for (let k = 0; k < taken.length; k += 2) { if (taken[k] > at) out.push(at, taken[k]); at = Math.max(at, taken[k + 1]); }
    if (at < total) out.push(at, total);
    return out;
  }

  const scenarioEntries = factors => [...factors].filter(([id, f]) => exists(id) && !flowOf(id) && Number.isFinite(f) && f >= 0 && f !== 1);
  const scenarioKey = factors => scenarioEntries(factors).map(([id, f]) => `${id}=${f}`).sort().join(',');
  let weightsCache = null, projectionCache = null;
  function project(factors) {
    const entries = scenarioEntries(factors), selected = new Map(entries);
    const effective = id => {
      let factor = 1;
      for (let p = id; p !== null && p !== ROOT2; p = callParent(p)) if (selected.has(p)) factor *= selected.get(p);
      return factor;
    };
    const key = `${definitionVersion}|${scenarioKey(factors)}`;
    const resultKey=`${key}|${version}`;
    if(projectionCache?.key===resultKey)return projectionCache.result;
    if (weightsCache?.key !== key) {
      const inputs = entries.map(([id]) => ({id, context:analysisOf(id), factor:effective(id)}))
        .sort((a,b) => coverageOf(b.id).parents.length - coverageOf(a.id).parents.length || callDepth(b.id) - callDepth(a.id) || Definitions.compare(a.id,b.id));
      weightsCache = {key, segments:units.map((u,i) => Definitions.weightedSegments(u.L,
        inputs.map(row => ({...row, intervals:intervals(i,row.id)}))))};
    }
    const NC = data.columns.length, N1 = data.partition.length - 1, P = N1 + 1;
    const columnData=data.columns.map(c=>nodeData(c.id));
    const eff = Float64Array.from(data.columns, c => independentOf(c.id) ? 1 : effective(c.id));
    const total = new Float64Array(X.NU), col = new Float64Array(X.NU * NC), own = new Float64Array(X.NU * P);
    const priority = Array.from({length:N1},(_,k)=>k).sort((a,b) =>
      coverageOf(data.columns[b].id).parents.length - coverageOf(data.columns[a].id).parents.length ||
      callDepth(data.columns[b].id) - callDepth(data.columns[a].id) || Definitions.compare(data.columns[a].id,data.columns[b].id));
    for (let i = 0; i < X.NU; i++) {
      const u = units[i], segments = weightsCache.segments[i], integrate = iv => Definitions.integrate(iv,segments,u.L);
      total[i] = Math.max(1e-3, integrate([0,u.L]) / 1000);
      for (let k = 0; k < NC; k++) {
        const id = data.columns[k].id, iv = columnData[k].iv[i];
        col[i * NC + k] = (independentOf(id) ? lengthOf(iv) : integrate(iv)) / 1000;
      }
      let taken = [];
      for (const k of priority) {
        const piece = subtract(columnData[k].iv[i],taken);
        own[i * P + k] = integrate(piece) / u.L; taken = unite(taken,piece);
      }
      own[i * P + N1] = integrate(outside(taken,u.L)) / u.L;
    }
    const result={total,col,own,eff,P,segments:weightsCache.segments};projectionCache={key:resultKey,result};return result;
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
    for (const id of [...paths.filter((p) => !p.independent && p.id !== rootPath && (p.n || activeSources.has(p.key))).map((p) => p.key),
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
      .sort((a, b) => nodes[b].depth - nodes[a].depth || callDepth(nodes[b].id) - callDepth(nodes[a].id) || Definitions.compare(nodes[a].id, nodes[b].id));
    // What-if factors still use the displayed violins' ownership in each tree. Integrate their exact interval
    // weights over the finer partition, rather than spreading a parent's saving evenly over its children.
    const visible = projection && !projection.segments ? data.columns.map((c, k) => k).filter((k) => !data.columns[k].second || !data.columns[k].async)
      .sort((a, b) => X.depthIdx[b] - X.depthIdx[a] || callDepth(data.columns[b].id) - callDepth(data.columns[a].id) || Definitions.compare(data.columns[a].id, data.columns[b].id)) : [];
    const rows = units.map((u, i) => {
      const events = [], segments = projection?.segments?.[i] || [];
      if (projection && !projection.segments) for (const second of [false, true]) {
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
      if (!projection?.segments && at < u.L) segments.push([at, u.L, factors[0] * factors[1]]);
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
    data.columns = cols.map(({ id, label: l, parent, merged, tree, async, dependency, independent }) => ({ id, label: l, parent, merged, async, dependency, independent, second: tree === 2, analysis: analysisOf(id) }));
    // The split of a unit's time is the first tree's; the second takes nothing from it.
    data.partition = cols.slice(0, N1).map((c) => ({ id: c.id, label: c.label, family: c.family, from: [c.id] }))
      .concat([{ id: '~none', label: 'Under no violin', family: 'other', from: [] }]);
    // Which column counts a moment covered by several, in each tree: the deepest shown, then the deepest in the call
    // tree.
    const order = (a, b) => Array.from({ length: b - a }, (_, k) => a + k)
      .sort((x, y) => cols[y].depth - cols[x].depth || callDepth(cols[y].id) - callDepth(cols[x].id) || Definitions.compare(cols[x].id, cols[y].id));
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
      // Projection analyses have independent ownership. Scenario intersections are integrated on demand.
      if (N1 < NC) {
        for (const context of new Set(prio2.map(k => data.columns[k].analysis))) split(prio2.filter(k => data.columns[k].analysis === context));
      }
      u.s = s; u.f = fr; u.c = c; u.p = p; u.o = own;
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
    return { v: 6, definitions:[...L.definitions].map(([id,d])=>[id,d.inputs]), parents: [...L.parents], shown: [...L.shown], open: [...L.open], order: [...L.order], except: [...L.except], bounds: [...L.bounds], retained: [...L.retained], skip: [...L.skip], next: L.next, nextScope: L.nextScope, names: [...L.names], top2: [...L.top2],
      groups: [...L.groups].map(([id, d]) => [id, d.label, d.inputs,
        Object.assign({}, d.tree === 2 ? { tree: 2, scope: d.scope || '' } : {}, d.match ? { match: d.match } : {}, d.parent ? { parent: d.parent } : {})]) };
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
        const g = newGroup();
        L.groups.set(g, definition({label: `${d.label} · separate flows`, members: parallel, tree: 2})); L.shown.add(g);
      }
      return id;
    };
    for (const id of [...L.groups.keys()]) convert(id);
    for (const id of [...L.shown]) convert(id);
  }
  // Loading preserves nested definitions, including single parts left after explicit membership edits.
  function load(s, exact = false) {
    activeSources = new Set();
    if (s) {
      s = Definitions.validate(rootKey(), s);
      // Keep unavailable source descriptors in the model. Their measured coverage is zero until data supplies them.
      const ensure = id => {
        const rest=Definitions.restParts(id);if(rest){rest.forEach(ensure);return;}
        const key = Definitions.source(id);
        if (typeof key !== 'string' || !key.startsWith(rootKey() + SEP)) return;
        const names = key.split(SEP); let parent = rootPath, prefix = names[0];
        for (const name of names.slice(1)) {
          prefix += SEP + name;
          activeSources.add(prefix);
          const p = intern(prefix, name, parent);
          if (!paths[p].n) { paths[p].main = true; paths[p].independent = false; }
          parent = p;
        }
      };
      for (const key of ['shown','open','skip','top2']) for (const id of s[key] || []) ensure(id);
      const ensureInput=input=>{ensure(Definitions.inputKey(input));for(const cut of input.cuts || [])Definitions.mapExpression(cut,path=>{ensure(path);return path;});};
      for (const [, , inputs] of s.groups || []) inputs.forEach(ensureInput);
      for (const [id,inputs] of s.definitions || []) {ensure(id);inputs.forEach(ensureInput);}
      for (const key of ['parents','order','except','bounds','names']) for (const [id, value] of s[key] || []) {
        ensure(id); if (key !== 'names') (Array.isArray(value) ? value : [value]).forEach(ensure);
      }
      for (const [id, cuts] of s.retained || []) { ensure(id); for (const cut of cuts) Definitions.mapExpression(cut,key => { ensure(key); return key; }); }
    }
    L.shown = new Set(); L.groups = new Map(); L.names = new Map(); L.top2 = new Set(); L.open = new Set(); L.order = new Map(); L.parents = new Map(); L.except = new Map(); L.bounds = new Map(); L.skip = new Set(); L.next = 1; L.nextScope = 1;
    L.retained = new Map(s?.retained || []);
    L.definitions = new Map((s?.definitions || []).map(([id,inputs])=>[id,definition({inputs})]));
    if (!s) return false;
    const groups = new Map((s.groups || []).map(([id, name, inputs, more]) => [id, definition(Object.assign({ label: name, inputs }, more || {}))]));
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, d] of groups) {
        const ok = d.members.filter((m) => isPath(m) || isCopy(m) || m === REST || groups.has(m));
        if (ok.length !== d.members.length) { d.members = ok; changed = true; }
      }
    }
    // Migrate the old nested-group relation into actual composition, keeping each operand intact.
    for (const [id, d] of groups) if (d.parent && groups.has(d.parent)) {
      const parent = groups.get(d.parent);
      parent.members = parent.members.filter((m) => !d.members.includes(m));
      if (!parent.members.includes(id)) parent.members = [...parent.members,id];
      delete d.parent;
    }
    L.groups = groups;
    if((s.v || 0)>=6)for(const [id,d] of recipes())if(treeOf(id)===1 && d.inputs.some(input=>input.span ? paths[pathOf(input.span)]?.independent : independentOf(input.violin)))throw Error('Independent async work belongs in Projections');
    for (const id of groups.keys()) L.next = Math.max(L.next, Number(id.slice(1)) + 1 || 1);
    L.next = Math.max(L.next, s.next || 1);
    L.nextScope = Math.max(1, s.nextScope || 1);
    const scopes = (s.groups || []).flatMap(g => g[2].map(Definitions.inputKey)).concat(s.top2 || [], s.shown || []);
    for (const id of scopes) if (isCopy(id)) L.nextScope = Math.max(L.nextScope, Number(scopeOf(id)) + 1 || 1);
    for (const d of groups.values()) L.nextScope = Math.max(L.nextScope, Number(d.scope) + 1 || 1);
    for (const [id, name] of s.names || []) if (spanName(id) && name) L.names.set(id, name);
    for (const [id, p] of s.parents || []) if (exists(id) && (exists(p) || p === ROOT2)) L.parents.set(id, p);
    for (const id of s.top2 || []) if (isCopy(id)) L.top2.add(id);
    for (const [p, list] of s.order || []) L.order.set(p, list);
    for (const id of s.skip || []) if (exists(id)) L.skip.add(id);
    relink();
    for (const [id, list] of s.except || []) if (exists(id)) { const ok = list.filter((m) => pathOf(m) >= 0); if (ok.length) L.except.set(id, ok); }
    for (const [id, list] of s.bounds || []) if (exists(id)) L.bounds.set(id,list);
    for (const id of s.shown || []) if (exists(id)) L.shown.add(id);
    for (const id of s.open || []) if (exists(id)) L.open.add(id);
    // Saved before closing kept what was under a node: every node with a child shown was open.
    if (!s.v || s.v < 2) for (const id of L.shown) { const p = parentOf(id); if (p !== null && !isRoot(p)) L.open.add(p); }
    if (!exact) separateAsync();
    relink();
    if (!exact && (s.v || 0) < 5) {
      const projections = modelChildren(ROOT2).filter(id => L.groups.has(id) || L.top2.has(id));
      for (const id of projections) {
        const replacement = duplicate(id, 2, true, undefined, true);
        if (isCopy(replacement)) L.top2.add(replacement);
        relink();
      }
    }
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
      const query = d.match.text.trim().toLocaleLowerCase();
      const more = paths.filter(p => p.id !== rootPath && (d.tree === 2 || !p.independent) && p.name.toLocaleLowerCase().includes(query))
        .map(p => d.tree === 2 ? copyOf(p.key, scopeOf(id)) : p.key)
        .filter(m => under === ROOT2 || inside(m, under))
        .filter((m) => pathOf(m) >= 0 && !memberOf.has(m) && !d.members.some((x) => inside(m, x) || inside(x, m)));
      if (!more.length) continue;
      d.members = [...d.members,...more.filter((m) => !more.some((y) => y !== m && inside(m, y)))];
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
  const snapshot = () => JSON.stringify({layout:state(),factors:[...(X.S?.factors || [])]});
  function restoreSnapshot(value) {
    const saved = JSON.parse(value);
    if (X.S?.factors) X.S.factors = new Map(saved.factors);
    load(saved.layout, true); relink(); settle(); apply(); X.emit('history', {edit:false});
  }
  function undo() { if (!past.length) return false; future.push(snapshot()); restoreSnapshot(past.pop()); return true; }
  function redo() { if (!future.length) return false; past.push(snapshot()); restoreSnapshot(future.pop()); return true; }
  function check() {
    const seen = new Set();
    for (const [g, d] of L.groups) {
      for (const m of d.members) {
        if (!exists(m) || treeOf(m) !== treeOf(g) || seen.has(m)) throw new Error(`Invalid or duplicate member: ${m}`);
        seen.add(m);
      }
    }
    for (const id of paths.map((p) => p.key).concat([...in2], [...L.groups.keys()])) {
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
      Definitions.validate(rootKey(),state());
      apply();
      if (X.checkLayout) check();
      past.push(before); if (past.length > 100) past.shift(); future.length = 0;
      X.emit('history', {edit:true, action});
      return r;
    } catch (e) { restoreSnapshot(before); throw e; }
  }; }


  X.layout = {
    get ready() { return ready; },
    get version() { return version; },
    progress: () => [X.chunksLoaded(), X.chunkCount],
    rootKey: () => (ready ? rootKey() : null),
    label, spanName, inside, parentOf, canMerge, treeOf, sourceKey: Definitions.source, scopeOf,
    hasPath: (id) => pathByKey.has(id) && paths[pathByKey.get(id)].n > 0,
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
      return [...new Set(spansOf(id).map(spanName))];
    },
    // How many spans a node has: one path, or a merged node's paths.
    size: id => spansOf(id).length,
    // Whether the second tree has anything in it.
    get second() { return kidsOfNode(ROOT2).length > 0; },
    candidates: (under, query) => candidates(under === X.ROOT ? rootKey() : under, query),
    kids: (id) => kidsOfNode(id === X.ROOT ? rootKey() : id),
    shown: (id) => shownOf(id === X.ROOT ? rootKey() : id),
    isMerged: (id) => L.groups.has(id),
    // A merged node's spans; a path or the rest, itself.
    members: (id) => (L.groups.has(id) ? L.groups.get(id).members.slice() : exists(id) ? [id] : []),
    inputs: id => inputsOf(id).map(Definitions.typedInput),
    kind: id => {const inputs=inputsOf(id);return !inputs.length ? 'derived' : inputs.some(i=>i.violin) ? inputs.some(i=>i.span) ? 'mixed' : 'derived' : 'span';},
    isRest, restsOf,
    replaceInput: change(replaceInput),
    removeInput: change(removeInput), inputChoices, previewInput,
    inputMs: (owner,index) => {const input=inputsOf(owner)[index];return Float64Array.from(units,(_,i)=>lengthOf(intersection(inputIntervals(i,owner,input),intervals(i,owner)))/1000);},
    restoreInputCut: change((owner,index,cut)=>{const input=inputsOf(owner)[index];if(!input)return;input.cuts=(input.cuts || []).filter((_,k)=>k!==cut);if(!input.cuts.length)delete input.cuts;}),
    setFactor:change((id,f)=>{if(!X.S?.factors)return;if(f===1)X.S.factors.delete(id);else X.S.factors.set(id,f);},'what-if'),
    clearFactors:change(()=>X.S?.factors.clear(),'what-if'),
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
    skippedAbove: (id) => skippedAbove(id),
    dominator: (ids) => dominator(ids),
    unskip: change(unskip),
    exclude: change(exclude),
    unexclude: change(unexclude),
    include: change(include),
    excluded: (id) => (L.except.get(id) || []).slice(),
    retained: id => (L.retained.get(id) || []).slice(),
    restoreRetained: change((id,index) => { const cuts=(L.retained.get(id) || []).filter((_,k)=>k!==index); if(cuts.length)L.retained.set(id,cuts);else L.retained.delete(id); }),
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
    constrained,
    rename: change(rename),
    suggestName: (ids) => suggestName(ids),
    reset: change(reset),
    // Back to the unit's span and its larger children, whatever the page was saved with.
    fresh: change(fresh),
    // What is shown, as data, to save into a page; and the layout saved into this one.
    state: () => JSON.parse(JSON.stringify(state())),
    load: change((s) => load(JSON.parse(JSON.stringify(s)))),
    check, undo, redo, breakdown, destinations, transferPreview, transferProblem, transfer: change(transfer),
    project, scenarioKey, scenarioActive: factors => scenarioEntries(factors).length > 0,
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
