// Recorded critical path: ordinary calls are sequential; spawn and dependency links add DAG edges.
(function () {
  'use strict';
  const cache = new WeakMap();
  function criticalPath(tree, flow) {
    if (cache.has(tree)) return cache.get(tree);
    const f = tree.rows, n = f.length / 5, reasons = new Set(), flows = new Map(), waits = new Map(), links = [], childEnd = new Map();
    // Equal recorded nanosecond boundaries must map to the same vertex after JSON float conversion.
    const stamp = t => Math.round(t * 1000) / 1000;
    const start = r => stamp(f[r * 5 + 2]), end = r => stamp(f[r * 5 + 2] + f[r * 5 + 3]);
    for (let r = 0; r < n; r++) {
      if (flow.root[r] === r) flows.set(r, {times:new Set([start(r), end(r)]), blocked:[]});
      if (f[r * 5 + 4] & 8) reasons.add('Missing prerequisite spans');
      if (flow.start[r] && !(f[r * 5 + 4] & 4)) reasons.add('Legacy flow boundaries');
      const p = f[r * 5 + 1];
      if (p >= 0 && !flow.start[r] && (start(r) < start(p) || end(r) > end(p))) reasons.add('Inconsistent call timestamps');
      if (p >= 0 && !flow.start[r] && end(r) > start(r)) {
        if ((childEnd.get(p) ?? -Infinity) > start(r)) reasons.add('Overlapping sequential siblings');
        childEnd.set(p, Math.max(childEnd.get(p) ?? -Infinity, end(r)));
      }
    }
    const point = (r, t) => {
      const root = flow.root[r];
      if (t < start(root) || t > end(root)) { reasons.add('Inconsistent dependency timestamps'); return null; }
      flows.get(root).times.add(t);
      return [root, t];
    };
    // Only causal boundaries need vertices; ordinary nested spans share their flow's timeline.
    for (const [r] of flows) if (r) {
      const p = f[r * 5 + 1], at = point(p, start(r));
      if (at) links.push([at, [r, start(r)]]);
    }
    const flatLinks = tree.links || [];
    for (let k = 0; k < flatLinks.length; k += 3) {
      const r = flatLinks[k], target = flatLinks[k + 1], relation = flatLinks[k + 2];
      if (r < 0 || r >= n || target < 0 || target >= n) { reasons.add('Missing prerequisite spans'); continue; }
      if (relation === 1) {
        if (!waits.has(r)) waits.set(r, []);
        waits.get(r).push(target);
      } else if (relation === 2) {
        if (end(target) > start(r)) { reasons.add('Inconsistent dependency timestamps'); continue; }
        const from = point(target, end(target)), to = point(r, start(r));
        if (from && to && (from[0] !== to[0] || from[1] !== to[1])) links.push([from, to, true]);
      }
    }
    for (const [r, targets] of waits) {
      if ((f[r * 5 + 4] & (2 | 8)) || flow.dependency[r] || targets.some(t => end(t) > end(r) || (flow.root[t] === flow.root[r] && end(t) > start(r)))) {
        reasons.add('Incomplete or legacy wait'); continue;
      }
      const ready = targets.reduce((t,r) => Math.max(t,end(r)), start(r)), a = point(r, start(r)), b = point(r, ready);
      if (!a || !b) continue;
      flows.get(a[0]).blocked.push([start(r), ready]);
      for (const target of targets) {
        const from = point(target, end(target));
        if (from && (from[0] !== b[0] || from[1] !== b[1])) links.push([from, b, true]);
      }
    }
    const nodes = [], edges = [], indices = new Map();
    const edge = (from, to, weight, segment = null, causal = false) => {
      const e = {from, to, weight, segment, causal}; nodes[from].out.push(edges.length); nodes[to].degree++; edges.push(e);
    };
    for (const [r, trace] of flows) {
      const times = [...trace.times].sort((a,b) => a-b), ids = new Map();
      trace.blocked.sort((a,b) => a[0]-b[0]);
      let blocked = 0, previous = -1;
      for (const t of times) {
        const id = nodes.length; ids.set(t, id); nodes.push({out:[], degree:0});
        if (previous >= 0) {
          const a = times[previous], b = t;
          while (blocked < trace.blocked.length && trace.blocked[blocked][1] <= a) blocked++;
          const waiting = blocked < trace.blocked.length && trace.blocked[blocked][0] <= a && trace.blocked[blocked][1] >= b;
          edge(id-1, id, waiting ? 0 : b-a, waiting ? null : [r,a,b]);
        }
        previous++;
      }
      indices.set(r, ids);
    }
    for (const [a,b,causal] of links) edge(indices.get(a[0]).get(a[1]), indices.get(b[0]).get(b[1]), 0, null, causal);
    const dist = new Float64Array(nodes.length).fill(-Infinity), back = new Int32Array(nodes.length).fill(-1), queue = [];
    dist[indices.get(0).get(start(0))] = 0;
    nodes.forEach((node,k) => { if (!node.degree) queue.push(k); });
    for (let k = 0; k < queue.length; k++) for (const ei of nodes[queue[k]].out) {
      const e = edges[ei], d = dist[e.from] + e.weight;
      if (d > dist[e.to] || (Number.isFinite(d) && d === dist[e.to] && e.causal && !edges[back[e.to]]?.causal)) { dist[e.to] = d; back[e.to] = ei; }
      if (!--nodes[e.to].degree) queue.push(e.to);
    }
    const segments = new Map(), last = indices.get(0).get(end(0));
    if (queue.length !== nodes.length) reasons.add('Cyclic dependencies');
    else for (let at = last; back[at] >= 0;) {
      const e = edges[back[at]];
      if (e.segment && e.weight > 0) {
        const [r,a,b] = e.segment;
        if (!segments.has(r)) segments.set(r, []);
        segments.get(r).push([a,b]);
      }
      at = e.from;
    }
    for (const spans of segments.values()) spans.reverse();
    if (Number.isFinite(dist[last]) && Math.abs(dist[last] - (end(0)-start(0))) > 0.01) reasons.add('Unexplained timing gaps');
    const result = {segments, reasons:[...reasons], duration:dist[last], vertices:nodes.length};
    cache.set(tree, result); return result;
  }
  if (typeof module !== 'undefined') module.exports = criticalPath;
  else window.TX.criticalPath = criticalPath;
})();
