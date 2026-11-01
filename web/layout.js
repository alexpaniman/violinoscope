(function () {
  'use strict';
  const X = window.TX,
    data = X.data,
    meta = X.meta;
  const Definitions = window.ViolinDefinitions,
    V = window.ViolinTree;
  // Inputs have nanosecond precision. Canonical endpoints prevent tiny phantom
  // overlaps when a fractional-microsecond start and duration are added.
  const spanEnd = (rows, r) => Math.round((rows[5*r+2] + rows[5*r+3]) * 1000) / 1000;
  const routes = [],
    routesByName = new Map(),
    routeParents = new Set(),
    routeKeys = new Map(),
    patterns = [],
    patternKeys = new Map(),
    variants = [],
    variantKeys = new Map();
  function internPattern(active) {
    const key = active.join();
    if (!patternKeys.has(key)) {
      patternKeys.set(key, patterns.length);
      patterns.push(active);
    }
    return patternKeys.get(key);
  }
  function activeOccurrence(route, absent) {
    if (!absent.length) return route;
    const key = route + '/' + absent.join();
    if (!variantKeys.has(key)) {
      variantKeys.set(key, -variants.length - 1);
      variants.push({ route, absent });
    }
    return variantKeys.get(key);
  }
  const occurrenceRoute = (entry) => (entry < 0 ? variants[-entry - 1].route : entry);
  function selects(plan, entry) {
    const r = occurrenceRoute(entry);
    return plan.selected[r] && (entry >= 0 || !plan.guards[r].some((q) => variants[-entry - 1].absent.includes(q)));
  }
  function routeFor(path, parent, independent = false) {
    const key = `${path}/${parent}/${independent}`;
    if (!routeKeys.has(key)) {
      routeKeys.set(key, routes.length);
      routes.push({ id: routes.length, path, parent, name: path < 0 ? V.GAP : paths[path].name, independent });
      const r=routes[routes.length-1];
      if(!routesByName.has(r.name))routesByName.set(r.name,[]);
      routesByName.get(r.name).push(r.id);
      if (parent >= 0) routeParents.add(parent);
    }
    return routeKeys.get(key);
  }
  const SEP = '\u0001',
    REST = '~rest';

  // ---------------------------------------------------------------------------------------------------------
  // The index: call paths, and in each unit, each path's spans: how many, their summed and self time, and the time
  // they cover as merged intervals in µs from the unit's start.

  const paths = [];
  const pathByKey = new Map();
  const units = new Array(X.NU).fill(null);
  let indexed = 0,
    rootPath = -1,
    ready = false;

  const pathText = new Map();
  function pathKey(id) {
    if (!pathText.has(id)) {
      const names=[];
      for(let p=id;p>=0;p=paths[p].parent)names.push(paths[p].name);
      pathText.set(id,names.reverse().join(SEP));
    }
    return pathText.get(id);
  }
  function intern(name, parent) {
    const key = parent + SEP + name;
    let id = pathByKey.get(key);
    if (id === undefined) {
      id = paths.length;
      paths.push({
        id,
        name,
        parent,
        depth: parent >= 0 ? paths[parent].depth + 1 : 0,
        kids: [],
        n: 0,
        share: 0,
        start: 0,
      });
      pathByKey.set(key, id);
      if (parent >= 0) paths[parent].kids.push(id);
    }
    return id;
  }

  // Merged length of flat intervals [a0, b0, a1, b1, …] within [lo, hi].
  function coveredIn(list, lo, hi) {
    if (!list) return 0;
    const pairs = [];
    for (let k = 0; k < list.length; k += 2) {
      const a = Math.max(lo, list[k]),
        b = Math.min(hi, list[k + 1]);
      if (b > a) pairs.push([a, b]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    let len = 0,
      a = -Infinity,
      b = -Infinity;
    for (const [x, y] of pairs) {
      if (x > b) {
        if (b > a) len += b - a;
        a = x;
        b = y;
      } else if (y > b) b = y;
    }
    return len + (b > a ? b - a : 0);
  }

  function indexUnit(i, chunk) {
    const u = data.units[i],
      tree = chunk.trees[i - u.k * meta.chunk],
      f = tree.rows,
      n = f.length / 5,
      flow = X.traceFlows(tree);
    const L = n ? Math.max(1, f[3]) : 1;
    const rowPath = new Int32Array(n),
      kids = new Array(n);
    for (let r = 0; r < n; r++) {
      const name = chunk.names[f[5 * r]],
        parent = f[5 * r + 1];
      rowPath[r] = intern(name, parent >= 0 ? rowPath[parent] : -1);
      const P = paths[rowPath[r]];
      P.main = P.main || !!flow.main[r];
      P.independent = !P.main;
      P.flow = P.flow || flow.root[r] > 0;
      P.dependency = P.dependency || !!flow.dependency[r];
      // A span's self time is its length less what its synchronous children cover.
      if (parent >= 0 && !(f[5 * r + 4] & 1))
        (kids[parent] || (kids[parent] = [])).push(f[5 * r + 2], spanEnd(f, r));
    }
    if (n && rootPath < 0) rootPath = rowPath[0];
    const order = Array.from({ length: n }, (_, r) => r).sort(
      (x, y) => rowPath[x] - rowPath[y] || f[5 * x + 2] - f[5 * y + 2],
    );
    const ids = [],
      off = [0],
      a = [],
      b = [],
      mainOff = [0],
      mainA = [],
      mainB = [],
      cnt = [],
      dur = [],
      self = [],
      flows = [];
    for (let q = 0; q < n; ) {
      const p = rowPath[order[q]],
        from = a.length,
        mainFrom = mainA.length;
      let c = 0,
        d = 0,
        s = 0,
        flowCount = 0;
      for (; q < n && rowPath[order[q]] === p; q++) {
        const r = order[q],
          s0 = f[5 * r + 2],
          s1 = spanEnd(f, r);
        if (flow.root[r] > 0) flowCount++;
        c++;
        d += s1 - s0;
        s += Math.max(0, s1 - s0 - coveredIn(kids[r], s0, s1));
        if (flow.main[r] && flow.hi[r] > flow.lo[r]) {
          const x = flow.lo[r],
            y = flow.hi[r];
          if (mainA.length > mainFrom && x <= mainB[mainB.length - 1])
            mainB[mainB.length - 1] = Math.max(mainB[mainB.length - 1], y);
          else {
            mainA.push(x);
            mainB.push(y);
          }
        }
        const x0 = flow.root[r] > 0 ? s0 : Math.max(0, s0),
          x1 = flow.root[r] > 0 ? s1 : Math.min(L, s1);
        if (x1 <= x0) continue;
        if (a.length > from && x0 <= b[b.length - 1]) b[b.length - 1] = Math.max(b[b.length - 1], x1);
        else {
          a.push(x0);
          b.push(x1);
        }
      }
      let len = 0;
      for (let k = from; k < a.length; k++) len += b[k] - a[k];
      const P = paths[p];
      P.n++;
      P.share += len / L;
      P.start += a.length > from ? a[from] / L : 1;
      ids.push(p);
      off.push(a.length);
      mainOff.push(mainA.length);
      cnt.push(c);
      dur.push(d);
      self.push(s);
      flows.push(flowCount);
    }
    units[i] = {
      L,
      rowPath,
      ids: Int32Array.from(ids),
      off: Int32Array.from(off),
      a: Float64Array.from(a),
      b: Float64Array.from(b),
      mainOff: Int32Array.from(mainOff),
      mainA: Float64Array.from(mainA),
      mainB: Float64Array.from(mainB),
      cnt: Int32Array.from(cnt),
      dur: Float64Array.from(dur),
      self: Float64Array.from(self),
      flows: Int32Array.from(flows),
    };
    indexAtoms(units[i], tree, flow);
    indexed++;
  }

  function indexChunk(k) {
    const chunk = X.chunk(k);
    if (!chunk) return;
    const first = k * meta.chunk,
      last = Math.min(X.NU, first + meta.chunk);
    for (let i = first; i < last; i++) if (!units[i]) indexUnit(i, chunk);
    if (indexed === X.NU && !ready) start();
  }

  // Where a path's entry is in a unit, or -1.
  function entry(i, p) {
    const ids = units[i].ids;
    let lo = 0,
      hi = ids.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (ids[m] === p) return m;
      if (ids[m] < p) lo = m + 1;
      else hi = m - 1;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------------------------------------
  function frames(iv, total) {
    const G = X.GRID,
      grid = [];
    if (!iv.length) return EMPTY;
    for (let k = 0; k < iv.length; k += 2) {
      if (iv[k + 1] <= 0 || iv[k] >= total) continue;
      const a = Math.floor((Math.max(0, iv[k]) * G) / total),
        b = Math.min(G, Math.max(a + 1, Math.ceil((iv[k + 1] * G) / total)));
      if (grid.length && a <= grid[grid.length - 1]) grid[grid.length - 1] = Math.max(grid[grid.length - 1], b);
      else grid.push(a, b);
    }
    const out = [];
    let at = 0;
    for (let k = 0; k < grid.length; k += 2) {
      out.push(grid[k] - at, grid[k + 1] - grid[k]);
      at = grid[k + 1];
    }
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

  // Two lists of intervals in order, apart from each other, as one.
  function unite(a, b) {
    const out = [];
    let i = 0,
      j = 0;
    while (i < a.length || j < b.length) {
      let x, y;
      if (j >= b.length || (i < a.length && a[i] <= b[j])) {
        x = a[i];
        y = a[i + 1];
        i += 2;
      } else {
        x = b[j];
        y = b[j + 1];
        j += 2;
      }
      if (out.length && x <= out[out.length - 1]) out[out.length - 1] = Math.max(out[out.length - 1], y);
      else out.push(x, y);
    }
    return out;
  }
  // Length of what two lists of disjoint intervals in order have in common; what a list leaves of [0, total).
  function overlap(a, b) {
    let i = 0,
      j = 0,
      len = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i], b[j]),
        hi = Math.min(a[i + 1], b[j + 1]);
      if (hi > lo) len += hi - lo;
      if (a[i + 1] < b[j + 1]) i += 2;
      else j += 2;
    }
    return len;
  }
  function intersection(a, b) {
    const out = [];
    let i = 0,
      j = 0;
    while (i < a.length && j < b.length) {
      const lo = Math.max(a[i], b[j]),
        hi = Math.min(a[i + 1], b[j + 1]);
      if (hi > lo) out.push(lo, hi);
      if (a[i + 1] < b[j + 1]) i += 2;
      else j += 2;
    }
    return out;
  }
  function outside(taken, total) {
    const out = [];
    let at = 0;
    for (let k = 0; k < taken.length; k += 2) {
      if (taken[k] > at) out.push(at, taken[k]);
      at = Math.max(at, taken[k + 1]);
    }
    if (at < total) out.push(at, total);
    return out;
  }

  const ROOT2 = X.ROOT2,
    EMPTY = Object.freeze([]),
    lengthOf = (iv) => {
      let n = 0;
      for (let j = 0; j < iv.length; j += 2) n += iv[j + 1] - iv[j];
      return n;
    };
  const append = (iv, a, b) => {
    if (b <= a) return;
    if (iv.length && a <= iv[iv.length - 1]) iv[iv.length - 1] = Math.max(iv[iv.length - 1], b);
    else iv.push(a, b);
  };
  const mergeFlat = (list) => {
    const pairs = [];
    for (let k = 0; k < list.length; k += 2) pairs.push([list[k], list[k + 1]]);
    pairs.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [a, b] of pairs) append(out, a, b);
    return out;
  };
  function uniteAll(lists) {
    let level = lists.filter(iv => iv.length);
    while (level.length > 1) {
      const next = [];
      for (let k=0; k<level.length; k+=2) next.push(k+1 < level.length ? unite(level[k],level[k+1]) : level[k]);
      level = next;
    }
    return level[0] || EMPTY;
  }
  // Each time slice keeps active recorded occurrences in a deterministic order. Only
  // selected occurrences compete; adding unselected instrumentation cannot change shares.
  function indexAtoms(U, recording, flow) {
    const rows = recording.rows,
      n = rows.length / 5,
      rowRoute = new Int32Array(n),
      all = [],
      mainEvents = [],
      projectionEvents = [];
    const lastChildEnd = new Float64Array(n).fill(-Infinity);
    let nested = true;
    for (let r = 0; r < n; r++) {
      const parent = rows[5 * r + 1],
        independent = !flow.main[r];
      const pr =
        parent >= 0 && !flow.main[parent] === independent && (!independent || flow.root[parent] === flow.root[r])
          ? rowRoute[parent]
          : -1;
      rowRoute[r] = routeFor(U.rowPath[r], pr, independent);
      const a = rows[5 * r + 2],
        b = spanEnd(rows, r),
        lo = Math.max(0, a),
        hi = Math.min(U.L, b);
      if (parent >= 0) {
        if (a < lastChildEnd[parent] || a < rows[5*parent+2] || b > spanEnd(rows,parent)) nested = false;
        lastChildEnd[parent] = Math.max(lastChildEnd[parent], b);
      }
      if (r > 0 && hi > lo) all.push(lo, hi);
      if (b > a) projectionEvents.push([a, r, 1], [b, r, 0]);
      if (flow.main[r] && flow.hi[r] > flow.lo[r]) mainEvents.push([flow.lo[r], r, 1], [flow.hi[r], r, 0]);
    }
    const gaps = outside(mergeFlat(all), U.L),
      gapRoute = routeFor(-1, rowRoute[0], false);
    function slices(events, main) {
      events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
      const active = new Set(),
        out = [];
      let at = events[0]?.[0] || 0;
      for (let k = 0; k < events.length; ) {
        const t = events[k][0];
        if (t > at && active.size) {
          const activeRows = [...active];
          // Nested calls and sampled stacks are already in ancestor order.
          if (nested) activeRows.reverse();
          else activeRows.sort(
              (a, b) =>
                paths[U.rowPath[b]].depth - paths[U.rowPath[a]].depth ||
                rows[5 * b + 2] - rows[5 * a + 2] ||
                rows[5 * a + 3] - rows[5 * b + 3] ||
                (pathKey(U.rowPath[a]) < pathKey(U.rowPath[b])
                  ? -1
                  : pathKey(U.rowPath[a]) > pathKey(U.rowPath[b])
                    ? 1
                    : 0),
            );
          const ordered = activeRows.map((r) => {
              const absent = [];
              if (!main)
                for (let p = rows[5 * r + 1]; p >= 0; p = rows[5 * p + 1]) if (!active.has(p)) absent.push(rowRoute[p]);
              return activeOccurrence(rowRoute[r], absent);
            });
          out.push([at, t, ordered]);
        }
        while (k < events.length && events[k][0] === t) {
          const [, r, on] = events[k++];
          if (on) active.add(r);
          else active.delete(r);
        }
        at = t;
      }
      // The fixed virtual source covers holes in recorded instrumentation, regardless of layout.
      return out;
    }
    U.rowRoute = rowRoute;
    U.slices = slices(mainEvents, true);
    const sameFlows = mainEvents.length === projectionEvents.length && flow.main.every((main,r) =>
      main && flow.lo[r] === rows[5*r+2] && flow.hi[r] === spanEnd(rows, r));
    U.projectionSlices = sameFlows ? U.slices : slices(projectionEvents, false);
    U.gaps = gaps;
    // Projection slices need gap endpoints too when independent work crosses a hole.
    const withGaps = (list) =>
      list.flatMap(([a, b, active]) => {
        const cuts = [a, b];
        for (const t of gaps) if (t > a && t < b) cuts.push(t);
        cuts.sort((x, y) => x - y);
        return cuts
          .slice(1)
          .map((t, k) => [cuts[k], t, overlap([cuts[k], t], gaps) > 0 ? [gapRoute, ...active] : active]);
      });
    U.slices = withGaps(U.slices);
    U.projectionSlices = sameFlows ? U.slices : withGaps(U.projectionSlices);
    for (const slice of sameFlows ? U.slices : [...U.slices, ...U.projectionSlices]) slice[2] = internPattern(slice[2]);
    const compact = (list) => Float64Array.from(list.flat());
    U.slices = compact(U.slices);
    U.projectionSlices = compact(U.projectionSlices);
    if (U.slices.length === U.projectionSlices.length && U.slices.every((v, i) => v === U.projectionSlices[i]))
      U.projectionSlices = U.slices;
  }
  let tree = null,
    version = 0,
    numericVersion = 0,
    numericKey = '',
    metrics = new Map(),
    plans = new Map(),
    candidateCache = new Map();
  const rootKey = () => paths[rootPath].name,
    normal = (id) => (id === X.ROOT ? rootKey() : id);
  const node = (id) => tree.get(normal(id)),
    isRoot = (id) => normal(id) === rootKey() || id === ROOT2,
    isRest = V.isRest;
  const label = (id) => tree.label(normal(id)),
    spanName = (id) => (node(id)?.span === V.GAP ? 'Not covered by spans' : node(id)?.span || label(id));
  const treeOf = (id) => (tree.analysis.get(isRest(id) ? id.slice(6) : normal(id)) === 'main' ? 1 : 2);
  const analysisOf = (id) => tree.analysis.get(isRest(id) ? id.slice(6) : normal(id));
  const parentOf = (id) => {
    if (isRest(id)) return id.slice(6);
    let p = tree.parents.get(normal(id));
    while (p && p !== ROOT2 && node(p)?.hidden) p = tree.parents.get(p);
    return p ?? null;
  };
  const modelParent = (id) => (isRest(id) ? id.slice(6) : tree.parents.get(normal(id)));
  function shown(id) {
    id = normal(id);
    if (id === rootKey()) return true;
    if (isRest(id)) return !!node(id)?.rest && shown(id.slice(6)) && !!node(id)?.open;
    const n = node(id);
    if (!n || n.hidden) return false;
    for (let p = modelParent(id); p && p !== ROOT2; p = modelParent(p))
      if (!node(p).hidden && !node(p).open) return false;
    return true;
  }
  function kids(id) {
    const out = [];
    for (const n of tree.children(normal(id))) {
      if (n.hidden) {
        out.push(...kids(n.id));
      } else out.push(n.id);
    }
    if (node(id)?.span && node(id).rest) out.push(V.rest(normal(id)));
    return out;
  }
  const signature = () =>
    JSON.stringify(
      [...tree.nodes.values()]
        .map((n) => [n.id, n.span ?? null, n.group !== undefined, modelParent(n.id)])
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
  const analysisCache = new Map();
  function recompute() {
    const key = signature();
    if (key === numericKey) return;
    const nextPlans = new Map(),
      next = new Map(),
      analyses = ['main', ...tree.state.projections.map((n) => n.id)];
    for (const analysis of analyses) {
      const members = [...tree.nodes.values()].filter((n) => tree.analysis.get(n.id) === analysis);
      const localKey = JSON.stringify(
        members.map((n) => [n.id, n.span ?? null, modelParent(n.id)]).sort((a, b) => a[0].localeCompare(b[0])),
      );
      let cached = analysisCache.get(analysis);
      if (cached?.key !== localKey) {
        const single = analysis !== 'main' && members.length === 1 && members[0].span;
        const selectedRoutes = single ? (routesByName.get(single)||[]).map(r=>routes[r]) : routes;
        const plan = tree.plan(routes, analysis, null, selectedRoutes),
          positions = new Map(plan.all.map((n, k) => [n.id, k]));
        const independentPatterns = new Uint8Array(patterns.length);
        const ownedPatterns = new Int32Array(patterns.length).fill(-1);
        const patternIds = single ? pickerIndex().touched(new Set([single])) : patterns.keys();
        for (const p of patternIds) {
          const active = patterns[p];
          let id = analysis === 'main' ? rootKey() : null;
          for (const entry of active)
            if (selects(plan, entry)) {
              const r = occurrenceRoute(entry);
              id = plan.owners[r];
              independentPatterns[p] = Number(routes[r].independent);
              break;
            }
          ownedPatterns[p] = positions.get(id) ?? -1;
        }
        const previous = new Map(cached?.plan.all.map((n, k) => [n.id, cached.details[k]]) || []),
          ownChanged = new Set(),
          coverageChanged = new Set(),
          fixedChanged = new Set();
        if (cached) {
          for (let p = 0; p < patterns.length; p++) {
            const now = ownedPatterns[p] >= 0 ? plan.all[ownedPatterns[p]].id : null,
              old = cached.ownedPatterns[p] >= 0 ? cached.plan.all[cached.ownedPatterns[p]].id : null;
            if (now !== old) {
              if (now) ownChanged.add(now);
              if (old) ownChanged.add(old);
            }
            const a = plan.ancestors.get(now) || EMPTY,
              b = cached.plan.ancestors.get(old) || EMPTY;
            if (independentPatterns[p] !== cached.independentPatterns[p] || now !== old) {
              for (const id of a) fixedChanged.add(id);
              for (const id of b) fixedChanged.add(id);
            } else if (independentPatterns[p]) {
              for (const id of a) if (!b.includes(id)) fixedChanged.add(id);
              for (const id of b) if (!a.includes(id)) fixedChanged.add(id);
            }
            for (const id of a) if (!b.includes(id)) coverageChanged.add(id);
            for (const id of b) if (!a.includes(id)) coverageChanged.add(id);
          }
        }
        for (const n of plan.all)
          if (!previous.has(n.id)) {
            ownChanged.add(n.id);
            coverageChanged.add(n.id);
            fixedChanged.add(n.id);
          }
        const countOwners = new Int32Array(routes.length).fill(-1);
        for(const r of selectedRoutes) {
            const id = plan.owners[r.id];
            countOwners[r.id] = id && r.name === tree.get(id)?.span && !(analysis === 'main' && r.independent)
              ? positions.get(id)
              : -1;
        }
        const countChanged = new Set();
        if(cached)for (let r = 0; r < routes.length; r++) {
          const now = countOwners[r] >= 0 ? plan.all[countOwners[r]].id : null,
            old = cached && cached.countOwners[r] >= 0 ? cached.plan.all[cached.countOwners[r]].id : null;
          if (now !== old) {
            if (now) countChanged.add(now);
            if (old) countChanged.add(old);
          }
        }
        for (const n of plan.all) if (!previous.has(n.id)) countChanged.add(n.id);
        const children = plan.all.map((n) => n.children.map((c) => positions.get(c.id))),
          details = plan.all.map((n) => {
            const old = previous.get(n.id),
              own = ownChanged.has(n.id),
              coverage = coverageChanged.has(n.id);
            return {
              fixed: fixedChanged.has(n.id) ? Array(X.NU) : old.fixed,
              iv: coverage ? Array(X.NU) : old.iv,
              own: own ? Array(X.NU) : old.own,
              ms: coverage ? new Float64Array(X.NU) : old.ms,
              count: countChanged.has(n.id) ? new Int32Array(X.NU) : old.count,
            };
          });
        const dirtyOwn = plan.all.map((n) => ownChanged.has(n.id)),
          dirtyCoverage = plan.all.map((n) => coverageChanged.has(n.id)),
          dirtyFixed = plan.all.map((n) => fixedChanged.has(n.id));
        const fixedTargets = plan.all.map((n) =>
          (plan.ancestors.get(n.id) || []).map((id) => positions.get(id)).filter((k) => dirtyFixed[k]),
        );
        const dirtyCount = plan.all.map((n) => countChanged.has(n.id));
        for (let i = 0; i < X.NU; i++) {
          const U = units[i],
            fixed = new Array(plan.all.length),
            owned = new Array(plan.all.length),
            slices = analysis === 'main' ? U.slices : U.projectionSlices;
          for (let j = 0; j < slices.length; j += 3) {
            const p = slices[j + 2],
              k = ownedPatterns[p];
            if (k >= 0) {
              if (dirtyOwn[k]) append(owned[k] ||= [], slices[j], slices[j + 1]);
              if (independentPatterns[p]) for (const at of fixedTargets[k]) append(fixed[at] ||= [], slices[j], slices[j + 1]);
            }
          }
          for (let k = plan.all.length - 1; k >= 0; k--) {
            const d = details[k];
            if (dirtyFixed[k]) d.fixed[i] = fixed[k] || EMPTY;
            if (dirtyOwn[k]) d.own[i] = owned[k] || EMPTY;
            if (dirtyCoverage[k]) {
              const iv = children[k].length ? uniteAll([d.own[i], ...children[k].map(child => details[child].iv[i])]) : d.own[i];
              d.iv[i] = iv.length ? iv : EMPTY;
              d.ms[i] = lengthOf(iv) / 1000;
            }
          }
          for (const r of U.rowRoute) {
            const k = countOwners[r];
            if (k >= 0 && dirtyCount[k]) details[k].count[i]++;
          }
        }
        cached = { key: localKey, plan, details, ownedPatterns, independentPatterns, countOwners };
        analysisCache.set(analysis, cached);
      }
      nextPlans.set(analysis, cached.plan);
      cached.plan.all.forEach((n, k) => next.set(n.id, cached.details[k]));
    }
    for (const id of analysisCache.keys()) if (!nextPlans.has(id)) analysisCache.delete(id);
    metrics = next;
    plans = nextPlans;
    numericKey = key;
    numericVersion++;
    for (const [id, value] of nodeCache) {
      const source = isRest(id) ? metrics.get(id.slice(6))?.own : metrics.get(normal(id))?.iv;
      if (value.source !== source || (!isRest(id) && value.c !== metrics.get(normal(id))?.count)) nodeCache.delete(id);
    }
    candidateCache.clear();
    scenarioCache = null;
    breakdownCache = null;
  }
  function intervals(i, id) {
    id = normal(id);
    return isRest(id) ? metrics.get(id.slice(6))?.own[i] || EMPTY : metrics.get(id)?.iv[i] || EMPTY;
  }
  function fixedIntervals(i, id) {
    id = normal(id);
    return isRest(id)
      ? intersection(intervals(i, id), metrics.get(id.slice(6))?.fixed[i] || EMPTY)
      : metrics.get(id)?.fixed[i] || EMPTY;
  }
  const msOf = (id) =>
    isRest(id)
      ? Float64Array.from(units, (_, i) => lengthOf(intervals(i, id)) / 1000)
      : metrics.get(normal(id))?.ms || new Float64Array(X.NU);
  const nodeCache = new Map(),
    measurementIds = new WeakMap();
  let nextMeasurement = 1;
  function measurementKey(id) {
    const iv = isRest(id) ? metrics.get(id.slice(6))?.own : metrics.get(normal(id))?.iv;
    if (!iv) return id;
    if (!measurementIds.has(iv)) measurementIds.set(iv, nextMeasurement++);
    return measurementIds.get(iv);
  }
  function nodeData(id) {
    if (nodeCache.has(id)) return nodeCache.get(id);
    const source = isRest(id) ? metrics.get(id.slice(6))?.own : metrics.get(normal(id))?.iv,
      iv = source || units.map(() => EMPTY),
      d = {
        source,
        iv,
        s: Float64Array.from(units, (u, i) => lengthOf(iv[i]) / u.L),
        f: units.map((u, i) => frames(iv[i], u.L)),
        c: metrics.get(id)?.count || new Int32Array(X.NU),
      };
    nodeCache.set(id, d);
    return d;
  }
  function matchedRoutes(id) {
    const plan = plans.get(analysisOf(id)),
      n = node(id);
    if (n?.group !== undefined) return n.children.flatMap((c) => matchedRoutes(c.id));
    return plan?.matches.get(normal(id)) || [];
  }
  const independent = (id) => matchedRoutes(id).length > 0 && matchedRoutes(id).every((r) => routes[r].independent);
  const flowOf = (id) => matchedRoutes(id).some((r) => routes[r].independent || paths[routes[r].path]?.flow);
  const dependency = (id) => matchedRoutes(id).some((r) => paths[routes[r].path]?.dependency);
  function expandable(id) {
    const n = node(id);
    if (!n || isRest(id)) return false;
    return n.group !== undefined || n.children.length > 0 || !!n.rest ||
      matchedRoutes(normal(id)).some(r => routeParents.has(r));
  }
  function hiddenCandidates(id, query = '') {
    id = normal(id);
    const q = query.toLowerCase(),
      list = tree
        .children(id)
        .filter((n) => n.hidden)
        .map((n) => ({ id: n.id, label: label(n.id), group: n.group !== undefined, ...share(n.id, id) }));
    if (node(id)?.span && !node(id).rest)
      list.push({ id: V.rest(id), label: label(V.rest(id)), rest: true, ...share(V.rest(id), id) });
    return list.filter((n) => n.label.toLowerCase().includes(q));
  }
  function share(id, parent) {
    let sum = 0,
      seen = 0,
      n = 0;
    const a = msOf(id),
      b = parent === ROOT2 ? data.units.map((u) => u.ms) : msOf(parent);
    for (let i = 0; i < X.NU; i++) {
      if (b[i] > 0) {
        sum += a[i] / b[i];
        n++;
      }
      if (a[i] > 0) seen++;
    }
    return { share: n ? sum / n : 0, seen: seen / X.NU };
  }
  const previewWeights = new Map();
  const previewSums = new Map();
  let previewIndex;
  function pickerIndex() {
    if (previewIndex) return previewIndex;
    const children=routes.map(()=>[]), byName=routesByName;
    for (const r of routes) {
      if(r.parent>=0)children[r.parent].push(r.id);
    }
    // A selector affects its call-route subtrees. DFS ranges avoid expanding and
    // sorting the same descendants for every name and every opened picker.
    const order=[], start=new Int32Array(routes.length), end=new Int32Array(routes.length);
    const stack=routes.filter(r=>r.parent<0).map(r=>r.id).reverse();
    while(stack.length) {
      const r=stack.pop();
      if(r<0){end[~r]=order.length;continue;}
      start[r]=order.length;order.push(r);stack.push(~r);
      for(let k=children[r].length-1;k>=0;k--)stack.push(children[r][k]);
    }
    const mergeRanges=list=>{
      list.sort((a,b)=>a[0]-b[0]);const out=[];
      for(const [a,b] of list)if(out.length&&a<=out[out.length-1])out[out.length-1]=Math.max(b,out[out.length-1]);else out.push(a,b);
      return out;
    };
    const ranges=new Map([...byName].map(([name,ids])=>[name,mergeRanges(ids.map(r=>[start[r],end[r]]))]));
    const namePatterns=new Map();
    patterns.forEach((entries,p)=>{
      const seen=new Set(),names=new Set();
      for(const entry of entries)for(let r=occurrenceRoute(entry);r>=0&&!seen.has(r);r=routes[r].parent) {
        seen.add(r);names.add(routes[r].name);
      }
      for(const name of names) {
        if(!namePatterns.has(name))namePatterns.set(name,[]);
        namePatterns.get(name).push(p);
      }
    });
    for(const [name,list] of namePatterns)namePatterns.set(name,Int32Array.from(list));
    function* changed(names) {
      let spans;
      if(names.size===1)spans=ranges.get(names.values().next().value)||[];
      else {
        const list=[];
        for(const name of names){const a=ranges.get(name)||[];for(let k=0;k<a.length;k+=2)list.push([a[k],a[k+1]]);}
        spans=mergeRanges(list);
      }
      for(let k=0;k<spans.length;k+=2)for(let j=spans[k];j<spans[k+1];j++)yield routes[order[j]];
    }
    const touched=names=>names.size===1 ? namePatterns.get(names.values().next().value)||[] :
      new Set([...names].flatMap(name=>Array.from(namePatterns.get(name)||[])));
    return previewIndex={changed,touched};
  }
  function* candidateSteps(parent, query = '') {
    parent = normal(parent);
    if (parent !== ROOT2 && !node(parent)) return [];
    const q = query.trim().toLowerCase();
    if (!candidateCache.has(parent)) {
      const main = parent !== ROOT2 && treeOf(parent) === 1,
        analysis = parent === ROOT2 ? null : analysisOf(parent),
        current = plans.get(analysis);
      let scope = parent;
      while (node(scope)?.group !== undefined) scope = modelParent(scope);
      const reachableNames = new Set(), reachable = new Uint8Array(routes.length);
      const inScope = new Set([...tree.nodes.keys()].filter(id => tree.inside(id, scope)));
      for (const r of routes) {
        if (main && r.independent) continue;
        if (scope === ROOT2) {
          reachableNames.add(r.name);
          continue;
        }
        reachable[r.id] = inScope.has(current?.owners[r.id]) || (r.parent >= 0 && reachable[r.parent]);
        if (reachable[r.id]) reachableNames.add(r.name);
      }
      const existing = new Set(
        parent === ROOT2
          ? []
          : tree
              .children(parent)
              .filter((n) => n.span)
              .map((n) => n.span),
      );
      if (!previewWeights.has(main)) {
        const weights = new Float64Array(patterns.length);
        for (const u of units) {
          const slices = main ? u.slices : u.projectionSlices;
          for (let j = 0; j < slices.length; j += 3) weights[slices[j + 2]] += slices[j + 1] - slices[j];
        }
        previewWeights.set(main, weights);
      }
      const weights = previewWeights.get(main),
        rows = [];
      // Independent single-name projections and an empty unit tree need no trial layout per name.
      // Sum each name once per interval pattern, preserving union semantics through recursion/overlap.
      const simple = parent === ROOT2 || (parent === rootKey() && !node(parent).children.length);
      if (simple && !previewSums.has(main)) {
        const sums = new Map();
        for (let p=0;p<patterns.length;p++) if (weights[p]) {
          const names = new Set(patterns[p].map(entry=>routes[occurrenceRoute(entry)].name));
          for (const name of names) sums.set(name,(sums.get(name)||0)+weights[p]);
        }
        previewSums.set(main,sums);
      }
      const unitTotal = units.reduce((s,u)=>s+u.L,0);
      const ownerOf=(plan,entries)=>{
        for(const entry of entries)if(selects(plan,entry))return plan.owners[occurrenceRoute(entry)];
        return analysis==='main'?rootKey():null;
      };
      const baseOwners = !simple ? patterns.map(entries=>ownerOf(current,entries)) : null;
      const parentNodes = new Set([...tree.nodes.keys()].filter(id => tree.inside(id, parent)));
      const inParent = owner=>parentNodes.has(owner);
      const baseTotal = !simple ? baseOwners.reduce((sum,owner,p)=>sum+(inParent(owner)?weights[p]:0),0) : 0;
      // Reuse one isolated trial tree; each preview changes only its new leaf's name.
      const trial = simple ? null : new V.Tree(rootKey(), paths, tree.state);
      const scratch = simple ? null : {owners:current.owners.slice(),selected:current.selected.slice(),guards:current.guards.slice(),touched:[]};
      let previewId, checkpoint = Date.now();
      for (const name of reachableNames) {
        if (Date.now() - checkpoint > 12) { yield; checkpoint = Date.now(); }
        if (existing.has(name) || name === node(parent)?.span) continue;
        if (simple) {
          const sum=previewSums.get(main).get(name)||0;
          const source=node(scope)?.span;
          if (sum || (source && tree.contains.get(source)?.has(name)))
            rows.push({id:V.pick(name),label:name===V.GAP?'Not covered by spans':name,share:sum/unitTotal});
          continue;
        }
        if (previewId) { trial.get(previewId).span = name; trial.refresh(); }
        else previewId = trial.create(name, parent);
        const id = previewId, context = analysis;
        let plan;
        const changedNames=new Set([name]);
        // Only membership changes to existing group bases affect selectors outside the new name's subtree.
        for(let g=parent;node(g)?.group!==undefined;g=modelParent(g)) {
          const before=tree.bases(g),after=trial.bases(g);
          for(const n of before)if(!after.has(n))changedNames.add(n);
          for(const n of after)if(!before.has(n))changedNames.add(n);
        }
        const index=pickerIndex(), touched=index.touched(changedNames);
        try {
          plan = trial.plan(routes, context, current, index.changed(changedNames), scratch);
        } catch (_) {
          continue;
        }
        let sum = 0,
          total = baseTotal;
        for (const pattern of touched)
          if (weights[pattern]) {
            const owner=ownerOf(plan,patterns[pattern]);
            if (owner === id) sum += weights[pattern];
            if(inParent(baseOwners[pattern]))total-=weights[pattern];
            if(owner===id||inParent(owner))total+=weights[pattern];
          }
        const source = node(scope)?.span;
        if (!sum && !(source && tree.contains.get(source)?.has(name))) continue;
        rows.push({
          id: V.pick(name),
          label: name === V.GAP ? 'Not covered by spans' : name,
          share: total ? sum / total : 0,
        });
      }
      rows.sort((a, b) => b.share - a.share || a.label.localeCompare(b.label));
      candidateCache.set(parent, rows);
    }
    return candidateCache.get(parent).filter((r) => r.label.toLowerCase().includes(q));
  }
  function candidates(parent, query = '') {
    const steps = candidateSteps(parent, query);
    let result; do { result = steps.next(); } while (!result.done);
    return result.value;
  }
  const candidateJobs = new Map();
  function candidatesAsync(parent, query = '') {
    parent = normal(parent);
    const version = numericVersion;
    if (candidateCache.has(parent)) return Promise.resolve(candidates(parent, query));
    let job = candidateJobs.get(parent);
    if (!job || job.version !== version) {
      job = {version, promise:(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        const steps = candidateSteps(parent);
        while (numericVersion === version) {
          const result = steps.next();
          if (result.done) return result.value;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        return null;
      })()};
      candidateJobs.set(parent, job);
      const clear = () => { if (candidateJobs.get(parent) === job) candidateJobs.delete(parent); };
      job.promise.then(clear, clear);
    }
    return job.promise.then(rows => rows?.filter(r => r.label.toLowerCase().includes(query.trim().toLowerCase())));
  }
  const blockedBy = (id) => plans.get(analysisOf(id))?.blocked.get(id) || null;
  function hiddenImpact(id) {
    return tree
      .children(normal(id))
      .some(
        (n) =>
          n.hidden &&
          (node(id)?.group !== undefined ||
            matchedRoutes(n.id).some(
              (r) =>
                routes[r].parent >= 0 && plans.get(analysisOf(n.id)).owners[routes[r].parent] !== modelParent(n.id),
            )),
      );
  }
  function skippedAbove(id) {
    const out = [];
    for (let p = modelParent(id); p && p !== ROOT2; p = modelParent(p)) {
      if (!node(p).hidden) break;
      out.unshift(p);
    }
    return out;
  }
  const factors = () => X.S?.factors || new Map();
  const scenarioKey = (fs) =>
    [...fs]
      .filter(([id, f]) => node(id) && !isRest(id) && !independent(id) && Number.isFinite(f) && f >= 0 && f !== 1)
      .map(([id, f]) => id + '=' + f)
      .sort()
      .join(',');
  let scenarioCache = null;
  function project(fs) {
    const key = numericVersion + '|' + version + '|' + scenarioKey(fs);
    if (scenarioCache?.key === key) return scenarioCache.value;
    const entries = [...fs].filter(([id, f]) => node(id) && !isRest(id) && !independent(id) && f !== 1),
      effective = (id) => {
        let f = 1;
        for (let p = id; p && p !== ROOT2; p = modelParent(p)) f *= fs.get(p) ?? 1;
        return f;
      };
    entries.sort(
      (a, b) => tree.depth.get(b[0]) - tree.depth.get(a[0]) || tree.signature(a[0]).localeCompare(tree.signature(b[0])),
    );
    const segments = units.map((u, i) =>
      Definitions.weightedSegments(
        u.L,
        entries.map(([id]) => ({
          id,
          context: analysisOf(id),
          factor: effective(id),
          intervals: subtract(intervals(i, id), fixedIntervals(i, id)),
        })),
      ),
    );
    const NC = data.columns.length,
      P = data.partition.length,
      N1 = P - 1,
      total = new Float64Array(X.NU),
      col = new Float64Array(X.NU * NC),
      own = new Float64Array(X.NU * P),
      eff = Float64Array.from(data.columns, (c) => (independent(c.id) || isRest(c.id) ? 1 : effective(c.id)));
    for (let i = 0; i < X.NU; i++) {
      const integrate = (iv) => {
        let n = lengthOf(iv) - overlap(iv, [0, units[i].L]);
        for (let k = 0; k < iv.length; k += 2)
          for (const [a, b, f] of segments[i])
            if (b > iv[k] && a < iv[k + 1]) n += Math.max(0, Math.min(b, iv[k + 1]) - Math.max(a, iv[k])) * f;
        return n;
      };
      total[i] = Math.max(1e-3, integrate([0, units[i].L]) / 1000);
      for (let k = 0; k < NC; k++) {
        const id = data.columns[k].id;
        col[i * NC + k] =
          (lengthOf(fixedIntervals(i, id)) + integrate(subtract(intervals(i, id), fixedIntervals(i, id)))) / 1000;
      }
      let taken = [];
      const order = Array.from({ length: N1 }, (_, k) => k).sort(
        (a, b) => data.columns[b].depth - data.columns[a].depth,
      );
      for (const k of order) {
        const iv = subtract(intervals(i, data.columns[k].id), taken);
        own[i * P + k] = integrate(iv) / units[i].L;
        taken = unite(taken, iv);
      }
      own[i * P + N1] = integrate(outside(taken, units[i].L)) / units[i].L;
    }
    const value = { total, col, own, eff, P, segments };
    scenarioCache = { key, value };
    return value;
  }
  let breakdownCache = null;
  function breakdown() {
    const key = numericVersion + '|' + scenarioKey(factors());
    if (breakdownCache?.key === key) return breakdownCache;
    const nodes = [],
      children = [],
      positions = new Map(),
      main = plans.get('main');
    const add = (id, text, parent, depth, merged = false) => {
      const at = nodes.length;
      positions.set(id, at);
      nodes.push({ id, label: text, parent, depth, merged });
      children.push([]);
      if (parent >= 0) children[parent].push(at);
      return at;
    };
    const visit = (n, parent = -1, depth = 0) => {
      const at = add(n.id, label(n.id), parent, depth, n.group !== undefined);
      n.children.forEach((c) => visit(c, at, depth + 1));
    };
    visit(tree.state.main);
    const detail = new Map();
    function recorded(r) {
      if (detail.has(r)) return detail.get(r);
      const route = routes[r],
        owner = main.owners[r];
      if (!owner || route.independent) return -1;
      if (main.selected[r] || route.path < 0) {
        const at = positions.get(owner);
        detail.set(r, at);
        return at;
      }
      const parent =
        route.parent >= 0 && main.owners[route.parent] === owner ? recorded(route.parent) : positions.get(owner);
      const id = '~detail:' + owner + ':' + route.path;
      const at = positions.has(id) ? positions.get(id) : add(id, route.name, parent, nodes[parent].depth + 1);
      detail.set(r, at);
      return at;
    }
    const patternOwn = patterns.map((active) => {
      let owner = rootKey();
      for (const entry of active)
        if (selects(main, entry)) {
          owner = main.owners[occurrenceRoute(entry)];
          break;
        }
      for (const entry of active) {
        const r = occurrenceRoute(entry);
        if (!routes[r].independent && main.owners[r] === owner) return recorded(r);
      }
      return positions.get(owner);
    });
    const none = add('~unassigned', 'Outside the included spans', -1, 0),
      scenario = scenarioKey(factors()) ? project(factors()) : null;
    const rows = units.map((u, i) => {
      const row = new Map();
      for (let j = 0; j < u.slices.length; j += 3) {
        const a = u.slices[j],
          b = u.slices[j + 1],
          pattern = u.slices[j + 2];
        let duration = b - a;
        if (scenario) {
          duration = 0;
          for (const [lo, hi, f] of scenario.segments[i])
            duration += Math.max(0, Math.min(b, hi) - Math.max(a, lo)) * f;
        }
        const at = patternOwn[pattern];
        row.set(at, (row.get(at) || 0) + duration / u.L);
      }
      return row;
    });
    return (breakdownCache = { key, nodes, children, tops: [0], none, rows });
  }
  let visiblePathOwners = new Int32Array(0),
    visibleRouteOwners = new Int32Array(0);
  function apply() {
    recompute();
    const cols = [];
    const visit = (n, parent, depth, second) => {
      if (n.hidden) {
        n.children.forEach((c) => visit(c, parent, depth, second));
        return;
      }
      cols.push({
        id: n.id,
        label: label(n.id),
        parent,
        depth,
        merged: n.group !== undefined,
        async: flowOf(n.id),
        dependency: dependency(n.id),
        independent: independent(n.id),
        second,
        analysis: analysisOf(n.id),
      });
      if (n.open) {
        n.children.forEach((c) => visit(c, n.id, depth + 1, second));
        if (n.span && n.rest)
          cols.push({
            id: V.rest(n.id),
            label: label(V.rest(n.id)),
            parent: n.id,
            depth: depth + 1,
            merged: false,
            second,
            analysis: analysisOf(n.id),
          });
      }
    };
    tree.state.main.children.forEach((n) => visit(n, X.ROOT, 1, false));
    if (tree.state.main.rest)
      cols.push({
        id: V.rest(rootKey()),
        label: label(V.rest(rootKey())),
        parent: X.ROOT,
        depth: 1,
        second: false,
        analysis: 'main',
      });
    const N1 = cols.length;
    tree.state.projections.forEach((n) => visit(n, ROOT2, 1, true));
    data.columns = cols;
    let family = 0;
    const families = new Map();
    for (const c of cols) {
      if (c.depth === 1) families.set(c.id, c.second || family >= 4 ? 'other' : 'f' + family++);
      else families.set(c.id, families.get(c.parent) || 'other');
    }
    data.partition = cols
      .slice(0, N1)
      .map((c) => ({ id: c.id, label: c.label, family: families.get(c.id), from: [c.id] }))
      .concat([{ id: '~none', label: 'Under no violin', family: 'other', from: [] }]);
    const NC = cols.length,
      made = cols.map((c) => nodeData(c.id)),
      positions = new Map(cols.map((c, k) => [c.id, k])),
      parents = cols.map((c) => positions.get(c.parent) ?? -1),
      counts = new Uint8Array(NC);
    for (let i = 0; i < X.NU; i++) {
      const u = data.units[i],
        s = u.s?.length === NC ? u.s : new Float64Array(NC),
        o = u.o?.length === NC ? u.o : new Float64Array(NC),
        c = u.c?.length === NC ? u.c : new Int32Array(NC),
        fr = u.f?.length === NC ? u.f : new Array(NC),
        p = u.p?.length === N1 + 1 ? u.p : new Float64Array(N1 + 1);
      for (let k = 0; k < NC; k++) {
        s[k] = o[k] = made[k].s[i];
        fr[k] = made[k].f[i];
        c[k] = made[k].c[i];
        if (c[k] > 1) counts[k] = 1;
      }
      // The allocation already makes sibling subtrees disjoint. Visible own time
      // is coverage minus direct visible children, including any revealed Rest.
      // Hidden intermediate nodes are lifted by visit(), so the same rule holds.
      let covered = 0;
      for (let k = 0; k < NC; k++) {
        if (parents[k] >= 0) o[parents[k]] -= s[k];
        else if (k < N1) covered += s[k];
      }
      for (let k = 0; k < NC; k++) {
        o[k] = Math.max(0, o[k]);
        if (k < N1) p[k] = o[k];
      }
      p[N1] = Math.max(0, 1 - covered);
      u.s = s;
      u.o = o;
      u.c = c;
      u.f = fr;
      u.p = p;
    }
    X.countFor = new Map();
    counts.forEach((v, k) => {
      if (v) X.countFor.set(k, k);
    });
    const at = new Map(cols.map((c, k) => [c.id, k]));
    visibleRouteOwners = new Int32Array(routes.length).fill(-1);
    visiblePathOwners = new Int32Array(paths.length).fill(-1);
    const main = plans.get('main');
    for (const r of routes) {
      let id = main.owners[r.id];
      while (id && !at.has(id)) id = modelParent(id);
      const k = at.get(id) ?? -1;
      visibleRouteOwners[r.id] = k;
      if (r.path >= 0 && !r.independent) visiblePathOwners[r.path] = k;
    }
    version++;
    scenarioCache = null;
    breakdownCache = null;
    X.reindex();
    X.tokens();
    save();
    X.emit('layout');
  }
  const saved = () => window.EXPLORER_LAYOUT || null,
    storeKey = () => `violinoscope.tree.${rootKey()}`;
  function save() {
    try {
      localStorage.setItem(storeKey(), JSON.stringify({ base: saved()?.saved || null, layout: tree.state }));
    } catch (_) {}
  }
  function load(s) {
    tree = new V.Tree(rootKey(), paths, V.migrate(rootKey(), s));
    if (X.S) X.S.factors.clear();
    return true;
  }
  function fresh() {
    tree = new V.Tree(rootKey(), paths);
    if (X.S) X.S.factors.clear();
  }
  function start() {
    ready = true;
    if (!meta.unit) X.UNIT = paths[rootPath].name;
    let own = null;
    try {
      own = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    } catch (_) {}
    load(own && own.base === (saved()?.saved || null) ? own.layout : saved()?.layout);
    apply();
  }
  const past = [],
    future = [],
    snapshot = () => JSON.stringify({ layout: tree.state, factors: [...factors()] });
  function restore(value) {
    const s = JSON.parse(value);
    load(s.layout);
    if (X.S) X.S.factors = new Map(s.factors);
    apply();
    X.emit('history', { edit: false });
  }
  function undo() {
    if (!past.length) return false;
    future.push(snapshot());
    restore(past.pop());
    return true;
  }
  function redo() {
    if (!future.length) return false;
    past.push(snapshot());
    restore(future.pop());
    return true;
  }
  function change(fn, action = fn.name) {
    return (...args) => {
      const before = snapshot();
      try {
        const result = fn(...args);
        tree.refresh();
        for (const id of factors().keys()) if (!tree.nodes.has(id)) factors().delete(id);
        V.validate(rootKey(), tree.state);
        if (snapshot() === before) return result;
        apply();
        past.push(before);
        if (past.length > 100) past.shift();
        future.length = 0;
        X.emit('history', { edit: true, action });
        return result;
      } catch (error) {
        restore(before);
        throw error;
      }
    };
  }
  function check() {
    V.validate(rootKey(), tree.state);
    for (const u of data.units) {
      if (Math.abs(u.p.reduce((a, b) => a + b, 0) - 1) > 1e-8) throw Error('Time is not conserved');
      if ([...u.s].some((x) => !Number.isFinite(x) || x < 0)) throw Error('Invalid timing');
    }
    for (const plan of plans.values())
      for (const n of plan.all) {
        const d = metrics.get(n.id);
        for (let i = 0; i < X.NU; i++) {
          const kids = n.children.reduce((sum, c) => sum + metrics.get(c.id).ms[i], 0);
          if (kids > d.ms[i] + 1e-7) throw Error('Children overlap or exceed their parent');
        }
      }
    return true;
  }
  const suggestName = (ids) => {
    const names = ids.map((id) => V.picked(id) || label(id));
    let s = names[0] || 'Group';
    for (const n of names) while (!n.startsWith(s)) s = s.slice(0, -1);
    return s.trim().length >= 3 ? s.trim() : names[0] || 'Group';
  };
  const canMerge = (a, b) =>
    a !== b &&
    node(a) &&
    node(b) &&
    !isRest(a) &&
    !isRest(b) &&
    !isRoot(a) &&
    !isRoot(b) &&
    treeOf(a) === treeOf(b) &&
    !(node(a).span && node(a).span === node(b).span) &&
    !tree.inside(a, b) &&
    !tree.inside(b, a);
  function destinations(id) {
    if (!node(id) || isRoot(id) || isRest(id)) return [];
    return [{ id: ROOT2, label: 'Projections' }, ...tree.nodes.values()]
      .filter(
        (n) =>
          n.id !== id &&
          !tree.inside(n.id, id) &&
          modelParent(id) !== n.id &&
          (!independent(id) || n.id === ROOT2 || treeOf(n.id) === 2) &&
          (n.id === ROOT2 || !node(id).span || !tree.children(n.id).some((c) => c.span === node(id).span)),
      )
      .map((n) => ({ id: n.id, label: n.label || label(n.id) }));
  }
  function add(ids, parent) {
    return tree.add(ids, normal(parent || rootKey()));
  }
  function merge(ids, name, unused, keep = true) {
    if (ids.some((id) => V.picked(id) !== null)) ids = add(ids, ROOT2);
    const id = tree.merge(ids, name);
    if (id) node(id).open = keep;
    return id;
  }
  function moveTo(id, parent, before = null) {
    parent = normal(parent);
    if (independent(id) && parent !== ROOT2 && treeOf(parent) === 1)
      throw Error('Independent work belongs in Projections');
    return tree.move(id, parent, before);
  }
  X.layout = {
    stats: () => ({
      paths: paths.length,
      routes: routes.length,
      patterns: patterns.length,
      variants: variants.length,
      mainSlices: units.reduce((s, u) => s + u.slices.length / 3, 0),
      projectionSlices: units.reduce((s, u) => s + u.projectionSlices.length / 3, 0),
    }),
    get ready() {
      return ready;
    },
    get version() {
      return version;
    },
    get second() {
      return tree.state.projections.length > 0;
    },
    get saved() {
      return saved();
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    rootKey: () => (ready ? rootKey() : null),
    progress: () => [X.chunksLoaded(), X.chunkCount],
    label,
    spanName,
    spanNames: (id) => (node(id)?.span ? [spanName(id)] : tree.frontier(id).map((n) => spanName(n.id))),
    state: () => JSON.parse(JSON.stringify(tree.state)),
    normalize: (s) => V.migrate(rootKey(), s),
    load: change(load),
    fresh: change(fresh),
    reset: change(() => load(saved()?.layout)),
    shown,
    parentOf,
    modelParent,
    treeOf,
    inside: (a, b) => tree.inside(a, b),
    sourceKey: (id) => node(id)?.span || id,
    scopeOf: analysisOf,
    kids,
    configuredChildren: (id) => tree.children(normal(id)).map((n) => n.id),
    hidden: (id) => hiddenCandidates(id).filter((n) => !n.rest).length,
    hiddenCandidates,
    hiddenImpact,
    blockedBy,
    open: (id) => !!node(id)?.open,
    isMerged: (id) => node(id)?.group !== undefined,
    isRest,
    size: (id) => (node(id)?.span ? 1 : tree.frontier(id).length),
    kind: (id) => (node(id)?.group !== undefined ? 'derived' : 'span'),
    members: (id) => (node(id)?.group !== undefined ? tree.children(id).map((n) => n.id) : [id]),
    restsOf: (id) => (node(id)?.span ? [V.rest(normal(id))] : []),
    addable: (id) => !isRest(id) && (!!node(id) || id === ROOT2),
    expandable,
    expand: change((id) => {
      if (node(id)) node(id).open = true;
    }),
    collapse: change((id) => {
      if (node(id) && !isRoot(id)) node(id).open = false;
    }),
    add: change(add),
    hide: change((id) => tree.hide(normal(id))),
    unskip: change((id) => tree.reveal(id)),
    skippedAbove,
    lifts: (id) => node(id)?.group !== undefined && node(id).open,
    remove: change((ids) => {
      for (const id of ids) tree.remove(id);
    }),
    clearChildren: change((id) => tree.clear(normal(id))),
    ungroup: change((id) => {
      if (node(id)?.group !== undefined) {
        node(id).open = true;
        tree.remove(id);
      }
    }),
    addGroup: change((ids, parent, name) => {
      const added = add(ids, parent);
      return tree.merge(added, name);
    }),
    merge: change(merge),
    canMerge,
    suggestName,
    copyOver: change((id, before = null) => {
      const copy = tree.duplicate(id);
      if (copy && before) tree.move(copy, ROOT2, before);
      return copy;
    }),
    move: change((id, next, after) => {
      const parent = modelParent(next),
        list = tree.children(parent),
        index = list.findIndex((n) => n.id === next);
      return moveTo(id, parent, after ? list[index + 1]?.id : next);
    }),
    transfer: change(moveTo),
    destinations,
    rename: change((id, name) => {
      if (isRest(id)) return;
      const n = node(id);
      if (n) {
        if (n.group !== undefined) n.group = name.trim() || n.group;
        else if (name.trim() && name.trim() !== n.span) n.name = name.trim();
        else delete n.name;
      }
    }),
    candidates,
    candidatesAsync,
    msOf,
    sig: measurementKey,
    async: flowOf,
    independent,
    dependency,
    hasPath: (p) => {
      let id=-1;
      for(const name of p.split(SEP)){id=pathByKey.get(id+SEP+name);if(id===undefined)return false;}
      return id>=0&&paths[id].n>0;
    },
    hasName: (name) => paths.some((x) => x.name === name),
    path: (p) => paths[p],
    pathsOf: (i) => units[i],
    partOfPath: (p) => visiblePathOwners[p] ?? -1,
    partOfRow: (i, r) => visibleRouteOwners[units[i]?.rowRoute[r]] ?? -1,
    under: (id) => {
      const p = modelParent(id);
      return p && !isRoot(p) ? label(p) : '';
    },
    setFactor: change((id, f) => {
      if (isRest(id) || !X.S) return;
      if (f === 1) X.S.factors.delete(id);
      else X.S.factors.set(id, f);
    }, 'what-if'),
    clearFactors: change(() => X.S?.factors.clear(), 'what-if'),
    project,
    scenarioKey,
    scenarioActive: (fs) => !!scenarioKey(fs),
    breakdown,
    undo,
    redo,
    check,
  };
  X.on('chunk', indexChunk);
})();
