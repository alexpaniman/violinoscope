// A flow boundary, its inherited flow, and its role in an elapsed-time breakdown are separate facts.
(function () {
  'use strict';
  const X = window.TX, cache = new WeakMap();
  X.traceFlows = (tree) => {
    if (cache.has(tree)) return cache.get(tree);
    const f = tree.rows, n = f.length / 5, links = tree.links || [];
    const root = new Int32Array(n), depth = new Int32Array(n), start = new Uint8Array(n);
    const dependency = new Uint8Array(n), invalid = new Uint8Array(n), main = new Uint8Array(n);
    const lo = new Float64Array(n), hi = new Float64Array(n);
    const extent = [0, 0];
    let mainDepth = 0;
    // Recognize dependency groups structurally: their explicit depends_on edges point to the child flows
    // they started. This identifies a group of dependencies, not the compiler's exact suspended interval.
    for (let q = 0; q < links.length; q += 3) {
      const from = links[q], to = links[q + 1];
      if (links[q + 2] !== 1 || from < 0 || from >= n || !(f[from * 5 + 4] & 1) || (f[from * 5 + 4] & 4)) continue;
      if (to >= 0 && to < n && f[to * 5 + 1] === from && (f[to * 5 + 4] & 1)) dependency[from] = 1;
      else invalid[from] = 1;
    }
    for (let r = 0; r < n; r++) {
      const p = f[r * 5 + 1], a = f[r * 5 + 2], b = Math.round((a + f[r * 5 + 3]) * 1000) / 1000;
      extent[0] = Math.min(extent[0], a / 1000); extent[1] = Math.max(extent[1], b / 1000);
      start[r] = Number(p >= 0 && !!(f[r * 5 + 4] & 1));
      root[r] = p < 0 || start[r] ? r : root[p];
      depth[r] = p < 0 || start[r] ? 0 : depth[p] + 1;
      if (!root[r]) mainDepth = Math.max(mainDepth, depth[r]);
      dependency[r] = Number(!!start[r] && !!dependency[r] && !invalid[r]);
      main[r] = Number(p < 0 || (main[p] && (!start[r] || dependency[r])));
      lo[r] = main[r] && p >= 0 ? Math.max(a, lo[p]) : a;
      hi[r] = main[r] && p >= 0 ? Math.min(b, hi[p]) : b;
    }
    const result = {root, depth, start, dependency, main, lo, hi, extent, mainDepth};
    cache.set(tree, result); return result;
  };
})();
