// Coarsen a partition without duplicating or losing any of its buckets.
(function () {
  'use strict';
  const X = window.TX;
  // Sum cubic coefficients, rather than materializing a grid value for every call path.
  // Slopes belong to individual paths: interpolating their sum would change the result.
  X.partSeries = (xs, groups, grid, count) => {
    const offsets = new Uint32Array(count + 1);
    for (const group of groups) for (const k of group.keys()) offsets[k + 1]++;
    for (let k = 0; k < count; k++) offsets[k + 1] += offsets[k];
    const cursor = offsets.slice(), bins = new Uint32Array(offsets[count]), ys = new Float64Array(bins.length), slopes = new Float64Array(bins.length);
    groups.forEach((group, b) => { for (const [k, value] of group) { const at = cursor[k]++; bins[at] = b; ys[at] = value; } });
    const h = xs.slice(1).map((x, b) => x - xs[b]);
    for (let k = 0; k < count; k++) for (let at = offsets[k]; at < offsets[k + 1]; at++) {
      const b = bins[at], y = ys[at];
      const before = at > offsets[k] && bins[at - 1] === b - 1 ? ys[at - 1] : 0;
      const after = at + 1 < offsets[k + 1] && bins[at + 1] === b + 1 ? ys[at + 1] : 0;
      const left = b ? (y - before) / h[b - 1] : 0, right = b + 1 < xs.length ? (after - y) / h[b] : 0;
      if (!b) slopes[at] = right;
      else if (b === xs.length - 1) slopes[at] = left;
      else if (left * right > 0) {
        const a = 2 * h[b] + h[b - 1], c = h[b] + 2 * h[b - 1];
        slopes[at] = (a + c) / (a / left + c / right);
      }
    }
    // An endpoint with zero value can still have a nonzero one-sided slope.
    const aggregate = ks => {
      const y = new Float64Array(xs.length), m = new Float64Array(xs.length);
      for (const k of ks) {
        for (let at = offsets[k]; at < offsets[k + 1]; at++) { y[bins[at]] += ys[at]; m[bins[at]] += slopes[at]; }
        if (xs.length > 1 && offsets[k] < offsets[k + 1]) {
          const a = offsets[k], b = offsets[k + 1] - 1;
          if (bins[a] === 1) m[0] += ys[a] / h[0];
          if (bins[b] === xs.length - 2) m[xs.length - 1] -= ys[b] / h[h.length - 1];
        }
      }
      return Float64Array.from(grid, x => {
        if (!xs.length) return 0;
        if (x <= xs[0]) return y[0];
        if (x >= xs[xs.length - 1]) return y[y.length - 1];
        let lo = 0, hi = xs.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
        const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
        return (2*t3-3*t2+1)*y[lo] + (t3-2*t2+t)*h[lo]*m[lo] + (-2*t3+3*t2)*y[hi] + (t3-t2)*h[lo]*m[hi];
      });
    };
    const total = aggregate(offsets.subarray(0, count).keys());
    const cache = new WeakMap();
    const values = ks => {
      if (!cache.has(ks)) cache.set(ks, aggregate(ks).map((v, j) => total[j] > 0 ? Math.max(0, v) / total[j] : 0));
      return cache.get(ks);
    };
    return {length:grid.length, values};
  };

  X.coarsenParts = (mean, children, tops, none, wide = 0.1, broad = 0.05) => {
    const subtrees = new Map();
    const under = k => { if (!subtrees.has(k)) subtrees.set(k, [k, ...(children[k] || []).flatMap(under)]); return subtrees.get(k); };
    const values = ks => Array.isArray(mean) ? mean.map(row => ks.reduce((a, k) => a + row[k], 0)) : mean.values(ks);
    const mass = (ks) => values(ks).reduce((a, v) => a + v, 0);
    const matters = (ks) => { const v = values(ks); return v.some((s) => s >= wide) || mass(ks) / Math.max(1, mean.length) >= broad; };
    function split(k, force = false) {
      const kids = children[k] || [], whole = under(k);
      const selected = new Set(kids.filter((c) => matters(under(c)))), promoted = new Set();
      // A meaningful child gets a name even if it matters only at one end of the duration axis.
      // Dominance is only a way to explain a meaningful leftover with a smaller named child.
      let remaining = kids.filter((c) => !selected.has(c));
      while (remaining.length) {
        const rest = [k, ...remaining.flatMap(under)];
        if (!matters(rest) && !(force && !selected.size)) break;
        const dominant = remaining.find((c) => mass(under(c)) > 0 && mass(under(c)) >= mass(rest) * 2 / 3);
        if (dominant === undefined) break;
        selected.add(dominant); promoted.add(dominant);
        remaining = remaining.filter((c) => c !== dominant);
      }
      if (!selected.size) return [{ks: whole, node: k, kind: 'whole', keep: force}];
      const parts = [{ks: [k], node: k, kind: 'own'}, ...kids.filter((c) => selected.has(c)).flatMap((c) => split(c, promoted.has(c)))];
      if (remaining.length) parts.push({ks: remaining.flatMap(under), node: k, kind: 'steps', roots: remaining});
      return parts;
    }
    const all = [...tops.flatMap((k) => split(k)), {ks:[none], node:none, kind:'whole'}], kept = [], other = [], components = [];
    for (const part of all) if (part.keep || matters(part.ks)) kept.push(part); else for (const k of part.ks) other.push(k);
    for (const part of all) if (!part.keep && !matters(part.ks)) components.push(part);
    if (other.length) {
      // After selecting meaningful work, spend a little of a large Other band's label space on smaller steps.
      // The combined area must fit the remaining Other label plus each extra label; promote at most two.
      const height = Math.max(210,(kept.length+1)*14), shares = values(other);
      let slots = Math.min(2,Math.max(0,Math.floor(Math.max(...shares)*height/14)-1));
      const candidates = components.flatMap(p => p.kind==='steps'
        ? p.roots.map(k=>({ks:under(k),node:k,kind:'whole'})) : [p]);
      const eligible = candidates.filter(p=>p.node!==none && p.kind!=='own' && mass(p.ks)/Math.max(1,mean.length)>=.015)
        .sort((a,b)=>mass(b.ks)-mass(a.ks));
      const promoted = new Set();
      if (mass(other)/Math.max(1,mean.length)>=.15) for (const p of eligible) {
        if (!slots--) break;
        kept.push({...p,extra:true});for(const k of p.ks)promoted.add(k);
      }
      const rest=other.filter(k=>!promoted.has(k));
      if(rest.length) kept.push({ks:rest,other:true,components:candidates.map(p=>({...p,ks:p.ks.filter(k=>!promoted.has(k))})).filter(p=>p.ks.length)});
    }
    return kept;
  };
})();
