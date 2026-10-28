// The explorer's data model: units of work from the summary, the value scales of each figure mode, and the
// figure specs the renderer draws.
(function () {
  'use strict';
  const R = window.ExplorerRender;

  const pctLabel = (v) => (v < 0.095 ? (v * 100).toFixed(1) : (v * 100).toFixed(0));
  const msLabel = (v) => (v <= 0.01 ? '<.01' : v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : v.toFixed(0));
  const MS_FLOOR = 0.01;
  const CALL_FLOOR = 0.001;

  function shareScale() {
    const ticks = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1].map((v) => ({ v, label: `${Math.round(v * 100)}%` }));
    return { name: 'share', fwd: (v) => Math.sqrt(Math.min(1, Math.max(0, v))), lo: 0, hi: 1, ticks,
      axis: "share of the query's compile time (square-root scale)", head: 'median, %', headLabel: pctLabel };
  }

  function logScale(name, floor, top, unit, axis, head, headLabel) {
    const all = [0.001, 0.01, 0.1, 1, 10, 100, 1000, 10000, 100000];
    const ticks = all.filter((v) => v >= floor && v <= top * 1.6)
      .map((v) => ({ v, label: v === floor ? `≤${v} ${unit}` : `${v} ${unit}` }));
    return { name, fwd: (v) => Math.log10(Math.max(v, floor)), lo: Math.log10(floor * 0.8), hi: Math.log10(Math.max(top, floor * 10) * 1.6),
      ticks, axis, head, headLabel };
  }

  function countScale(top) {
    const all = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const ticks = all.filter((v) => v <= Math.max(top, 2) * 1.1).map((v) => ({ v, label: String(v) }));
    return { name: 'counts', fwd: (v) => Math.log10(Math.max(0, v) + 1), lo: 0, hi: Math.log10(Math.max(top, 2) + 1) * 1.06, ticks,
      axis: 'times per query (log scale)', head: 'median', headLabel: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) };
  }

  function load(summary) {
    const data = {
      meta: summary.meta, columns: summary.columns, partition: summary.partition, families: summary.families,
      counts: summary.counts, units: summary.units, failures: summary.failures,
    };
    const groups = new Map();
    data.units.forEach((u, i) => {
      if (!groups.has(u.g)) groups.set(u.g, []);
      groups.get(u.g).push(i);
    });
    data.groups = Array.from(groups, ([id, units]) => ({ id, units })).sort((a, b) => b.units.length - a.units.length);
    data.columnIndex = new Map(data.columns.map((c, i) => [c.id, i]));
    // How many parts sit somewhere inside each part.
    data.descendants = new Map(data.columns.map((c) => [c.id, 0]));
    for (const c of data.columns) {
      for (let p = c.parent; p && data.columnIndex.has(p); p = data.columns[data.columnIndex.get(p)].parent) {
        data.descendants.set(p, data.descendants.get(p) + 1);
      }
    }
    return data;
  }

  // Whether a part is inside one of the folded parts.
  function hiddenBy(data, col, folded) {
    if (!folded || !folded.size) return false;
    for (let p = col.parent; p && data.columnIndex.has(p); p = data.columns[data.columnIndex.get(p)].parent) if (folded.has(p)) return true;
    return false;
  }

  // Mean share of each 1/BINS slice of the timeline that a column is busy, over the given units.
  function occupancy(data, col, units) {
    const B = R.BINS, scale = B / data.meta.units;
    const acc = new Float64Array(B);
    if (!units.length) return acc;
    for (const i of units) {
      const f = data.units[i].f[col];
      let at = 0;
      for (let j = 0; j < f.length; j += 2) {
        const a = (at + f[j]) * scale, b = (at + f[j] + f[j + 1]) * scale;
        at += f[j] + f[j + 1];
        for (let k = Math.floor(a); k < Math.min(B, Math.ceil(b)); k++) acc[k] += Math.min(b, k + 1) - Math.max(a, k);
      }
    }
    for (let k = 0; k < B; k++) acc[k] /= units.length;
    return acc;
  }

  // The columns, values and scale of one figure mode.
  //   share:  each part's share of the unit's time; with cpu, CPU time over wall time first
  //   ms:     whole unit, CPU time, then each part in milliseconds
  //   counts: how many times each counted span ran
  //   percall: a part's milliseconds divided by its count
  // opts.collapsed folds the parts inside each listed part into it (share and ms).
  function view(data, mode, opts) {
    const cols = data.columns;
    const unit = (i) => data.units[i];
    const shown = (col) => col.kind !== 'part' || !hiddenBy(data, data.columns[col.base], opts.collapsed);
    const pop = opts.left.concat(opts.right);
    const hasCpu = opts.cpu && data.units.some((u) => u.cpu !== null && u.cpu !== undefined);
    if (mode === 'share') {
      const columns = (hasCpu ? [{ id: '_cpu', label: 'CPU over wall time', parent: null, kind: 'cpu' }] : [])
        .concat(cols.map((c, k) => Object.assign({ kind: 'part', base: k }, c))).filter(shown);
      const value = (i, c) => {
        const col = columns[c], u = unit(i);
        if (col.kind === 'cpu') return u.cpu === null ? NaN : u.cpu / u.ms;
        return u.s[col.base];
      };
      return { columns, value, scale: shareScale(), timeline: true, tree: true };
    }
    if (mode === 'ms') {
      const columns = (hasCpu ? [{ id: '_cpu', label: 'CPU time', parent: null, kind: 'cpu' }] : [])
        .concat([{ id: '_total', label: 'Whole compilation', parent: null, kind: 'total' }])
        .concat(cols.map((c, k) => Object.assign({ kind: 'part', base: k }, c, { parent: c.parent || '_total' }))).filter(shown);
      const value = (i, c) => {
        const col = columns[c], u = unit(i);
        if (col.kind === 'cpu') return u.cpu === null ? NaN : Math.max(MS_FLOOR, u.cpu);
        if (col.kind === 'total') return u.ms;
        return Math.max(MS_FLOOR, u.s[col.base] * u.ms);
      };
      let top = MS_FLOOR;
      for (const i of pop) top = Math.max(top, unit(i).ms, unit(i).cpu || 0);
      return { columns, value, scale: logScale('ms', MS_FLOOR, top, 'ms', 'time per query (log scale)', 'median, ms', msLabel), timeline: true, tree: true };
    }
    if (mode === 'counts') {
      const columns = data.counts.map((c, k) => ({ id: c.id, label: c.label, parent: null, kind: 'count', base: k }));
      const value = (i, c) => unit(i).c[columns[c].base];
      let top = 1;
      for (const i of pop) for (const v of unit(i).c) top = Math.max(top, v);
      return { columns, value, scale: countScale(top), timeline: false, tree: false };
    }
    // percall
    const columns = data.counts.map((c, k) => ({ c, k })).filter(({ c }) => c.per_call_of && data.columnIndex.has(c.per_call_of))
      .map(({ c, k }) => ({ id: c.id, label: c.per_call_label || `${data.columns[data.columnIndex.get(c.per_call_of)].label} per run`,
        parent: null, kind: 'percall', base: k, part: data.columnIndex.get(c.per_call_of) }));
    const value = (i, c) => {
      const col = columns[c], u = unit(i), n = u.c[col.base];
      return n > 0 ? Math.max(CALL_FLOOR, u.s[col.part] * u.ms / n) : NaN;
    };
    let top = CALL_FLOOR;
    for (const i of pop) for (let c = 0; c < columns.length; c++) { const v = value(i, c); if (v > top) top = v; }
    return { columns, value, scale: logScale('percall', CALL_FLOOR, top, 'ms', 'time per call (log scale)', 'median, ms', msLabel),
      timeline: false, tree: false };
  }

  // A violin spec for the renderer.
  function violinSpec(data, mode, opts) {
    const v = view(data, mode, opts);
    const occupancyOf = (c, half) => {
      const col = v.columns[c];
      const units = half === 'left' ? opts.left : opts.right;
      if (col.kind === 'part') return occupancy(data, col.base, units);
      if (col.kind === 'total') return new Float64Array(R.BINS).fill(units.length ? 1 : 0);
      return null;
    };
    // Folded parts that hold others: their column index and how many parts they hold.
    const collapsed = new Map();
    v.columns.forEach((col, c) => {
      if (col.kind === 'part' && opts.collapsed && opts.collapsed.has(col.id) && data.descendants.get(col.id)) collapsed.set(c, data.descendants.get(col.id));
    });
    return {
      mode, view: v, columns: v.columns, value: v.value, scale: v.scale, left: opts.left, right: opts.right,
      markers: opts.markers || [], legend: opts.legend || [], occupancy: occupancyOf, seed: opts.seed || 0, collapsed,
      panels: { tree: v.tree && opts.panels !== false, timeline: v.timeline && opts.panels !== false && opts.timeline !== false },
    };
  }

  window.ExplorerModel = { load, view, violinSpec, occupancy, hiddenBy, pctLabel, msLabel };
})();
