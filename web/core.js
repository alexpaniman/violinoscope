// Shared by every view: the data, the state, what is in view, what-if projection, prepared violins, colours, text
// helpers and loading of span trees and per-name totals. Everything hangs off window.TX.
(function () {
  'use strict';
  const R = window.ExplorerRender, M = window.ExplorerModel;
  // As read, before the views add to it, for a page downloaded as one file.
  const summaryText = JSON.stringify(window.EXPLORER_SUMMARY);
  const data = M.load(window.EXPLORER_SUMMARY);
  const meta = data.meta;
  const X = window.TX = { R, M, data, meta, summaryText };

  X.SANS = "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";
  X.visibilityIcon = (hide = false) => `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.3-4.2 6.5-4.2S14.5 8 14.5 8 12.2 12.2 8 12.2 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="1.8"/>${hide ? '<path d="M2 2l12 12"/>' : ''}</svg>`;
  X.MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";
  X.MS_FLOOR = 0.01;
  X.NU = data.units.length;
  // What one unit is: the name of its span. "6,576 Compile query spans".
  X.UNIT = meta.unit || 'Unit';
  X.nUnits = (n) => `${X.fmtInt(n)} ${X.UNIT} ${n === 1 ? 'span' : 'spans'}`;
  X.GRID = meta.units || 500;
  X.STOPS = [0, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  const NAMES = meta.names || {};

  // ---------------------------------------------------------------------------------------------------------
  // Formatting.

  X.$ = (id) => document.getElementById(id);
  X.esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  X.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  X.n1 = (v) => (Math.round(v * 10) / 10).toString();
  X.groupName = (g) => NAMES[g] || g;
  X.fmtInt = (n) => n.toLocaleString('en-US');
  X.fmtMs = (v) => (!Number.isFinite(v) ? '–' : v >= 1000 ? `${(v / 1000).toPrecision(3)} s` : `${M.msLabel(v)} ms`);
  // A sum over many units: minutes and hours past a minute.
  X.fmtTotal = (ms) => (!Number.isFinite(ms) ? '–' : ms < 60000 ? X.fmtMs(ms) : ms < 3.6e6 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 3.6e6).toFixed(1)} h`);
  X.fmtUs = (ms) => (!Number.isFinite(ms) ? '–' : ms >= 1 ? X.fmtMs(ms) : ms >= 0.01 ? `${Math.round(ms * 1000)} µs` : `${Number((ms * 1000).toPrecision(2))} µs`);
  X.decade = (v) => (v >= 1000 ? `${v / 1000} s` : v >= 1 ? `${v} ms` : `${Number(v.toPrecision(1))} ms`);
  X.fmtPct = (v) => (Number.isFinite(v) ? `${M.pctLabel(v)}%` : '–');
  X.fmtFactor = (f) => `×${X.round3(f)}`;
  X.round3 = (v) => Number(v.toPrecision(3));
  X.sortedOf = (arr) => Float64Array.from(arr).sort();
  X.median = (arr) => R.quantile(X.sortedOf(arr), 0.5);
  X.mean = (arr) => { let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : NaN; };
  X.niceStep = (span, count) => {
    const raw = span / count, p = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  };
  // Durations for axes: the unit follows the step.
  X.fmtSpan = (ms, step) => {
    if (Math.abs(ms) < 1e-9) return '0';
    if (Math.abs(ms) >= 60000) {
      const m = Math.floor(ms / 60000), s = (ms - m * 60000) / 1000;
      return `${m}:${(step >= 1000 ? Math.round(s).toString() : s.toFixed(step >= 100 ? 1 : 3)).padStart(step >= 1000 ? 2 : (step >= 100 ? 4 : 6), '0')}`;
    }
    if (step >= 1000) return `${X.round3(ms / 1000)} s`;
    if (step >= 1) return `${X.round3(ms)} ms`;
    return `${X.round3(ms * 1000)} µs`;
  };

  // ---------------------------------------------------------------------------------------------------------
  // The columns as a tree, built again whenever the violins shown change (X.layout): each column's parent, children,
  // depth, top-level column and the last column of its subtree, which follows it.

  X.reindex = () => {
    data.columnIndex = new Map(data.columns.map((c, i) => [c.id, i]));
    X.NC = data.columns.length;
    X.parentIdx = data.columns.map((c) => (c.parent && data.columnIndex.has(c.parent) ? data.columnIndex.get(c.parent) : -1));
    X.kids = data.columns.map(() => []);
    X.parentIdx.forEach((p, k) => { if (p >= 0) X.kids[p].push(k); });
    X.depthIdx = X.parentIdx.map((_, k) => { let d = 0; for (let p = X.parentIdx[k]; p >= 0; p = X.parentIdx[p]) d++; return d; });
    X.rootOf = X.parentIdx.map((_, k) => { let r = k; while (X.parentIdx[r] >= 0) r = X.parentIdx[r]; return r; });
    X.subEnd = R.subtreeEnd(data.columns);
    for (const f of [() => occCache.clear(), X.forgetPrepared, X.forgetSpans]) if (f) f();
    X.project();
  };
  data.columns = [];
  data.partition = [];
  X.countFor = new Map();

  // ---------------------------------------------------------------------------------------------------------
  // State. The selection is one compilation or none; the compile-time range and the legend choose what is in view.

  const S = X.S = {
    // The tab and each tab's mode; view is what they put on screen: violins, flame (the flame chart by time or the
    // flame graph, heavy), timeline (the waterfall) or spans (the table, as a list or a tree).
    tab: 'violins', tl: 'chart', prof: 'table', view: 'violins', mode: 'share', linear: false, flame: 'time',
    side: {}, range: null, factors: new Map(),
    sel: null, card: null, hover: null, hoverCol: null, search: '', matches: null,
    sort: { key: 'self', dir: -1 }, tlSort: { key: 'ms', dir: -1 }, name: null, namePath: null, profileRoot: null, spansMode: 'table', tableTree: false, spansQuery: '', treeOpen: new Map(), treeLevel: 2,
  };
  const slot = new Map();
  {
    let k = 0;
    const right = new Set(meta.right || []), left = new Set(meta.left || []);
    if (!left.size) {
      const largest = data.groups.filter(g => !right.has(g.id)).sort((a,b) => b.units.length-a.units.length)[0];
      if (largest) left.add(largest.id);
    }
    for (const g of data.groups) {
      const side = left.has(g.id) ? 'left' : right.has(g.id) ? 'right' : g.units.length <= 5 ? 'marker' : 'off';
      S.side[g.id] = side;
      if (side === 'marker' || side === 'off') slot.set(g.id, k++ % 4);
    }
  }
  X.slotOf = (g) => (slot.has(g) ? slot.get(g) : 3);
  // The flame graph and the spans only include or leave out a group; including it again puts it back where it was.
  const lastSide = new Map();
  X.included = (g) => S.side[g] !== 'off';
  X.setIncluded = (g, on) => {
    if (on === X.included(g)) return;
    if (!on) { lastSide.set(g, S.side[g]); S.side[g] = 'off'; } else S.side[g] = lastSide.get(g) || 'marker';
  };
  // Every compilation in view, whatever its group's place in the violins.
  X.allInView = () => {
    const out = [];
    data.units.forEach((u, i) => {
      if (S.side[u.g] === 'off' || (S.range && (u.ms < S.range[0] || u.ms > S.range[1]))) return;
      out.push(i);
    });
    return out;
  };
  X.sideNames = (side) => data.groups.filter((g) => S.side[g.id] === side).map((g) => X.groupName(g.id)).join(' + ');
  X.sideKey = (g) => (S.side[g] === 'left' || S.side[g] === 'right' ? S.side[g] : `m${X.slotOf(g)}`);

  X.unitsInView = (withRange) => {
    const left = [], right = [], markers = new Map();
    data.units.forEach((u, i) => {
      if (withRange && S.range && (u.ms < S.range[0] || u.ms > S.range[1])) return;
      const side = S.side[u.g];
      if (side === 'left') left.push(i);
      else if (side === 'right') right.push(i);
      else if (side === 'marker') { if (!markers.has(u.g)) markers.set(u.g, []); markers.get(u.g).push(i); }
    });
    return { left, right, markers };
  };
  X.viewKey = () => `${JSON.stringify(S.side)}|${JSON.stringify(S.range)}`;
  // Every compilation in view, in groups as the legend lists them.
  X.groupsInView = () => {
    const v = X.unitsInView(true), out = [];
    for (const side of ['left', 'right', 'marker']) {
      for (const g of data.groups) {
        if (S.side[g.id] !== side) continue;
        const units = (side === 'marker' ? v.markers.get(g.id) || [] : v[side].filter((i) => data.units[i].g === g.id));
        if (units.length) out.push({ g: g.id, side, units, color: side === 'marker' ? `m${X.slotOf(g.id)}` : side });
      }
    }
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Factors belong to definitions, including hidden ones. Each analysis partitions its coverage; factors from
  // independent analyses multiply on their actual interval intersections.

  let proj = null;
  X.scenarioOn = () => X.layout?.ready && X.layout.scenarioActive(S.factors);
  X.scenarioKey = () => X.layout?.ready ? X.layout.scenarioKey(S.factors) : '';
  X.project = () => { proj = X.scenarioOn() ? X.layout.project(S.factors) : null; };
  X.proj = () => proj;
  X.partMs = (i, k, measured) => (proj && !measured ? proj.col[i * X.NC + k] : data.units[i].s[k] * data.units[i].ms);
  X.totalMs = (i, measured) => (proj && !measured ? proj.total[i] : data.units[i].ms);

  // ---------------------------------------------------------------------------------------------------------
  // Columns, scales and prepared violins. Both measures show the same columns, so switching keeps them in place.

  // The violins' columns: the unit's own span, the root the others branch from, then every column shown.
  // The second tree's columns come after the first's; its root (X.ROOT2) is not shown.
  X.ROOT = '_all';
  X.ROOT2 = '~two';
  X.columnsFor = () => [{ id: X.ROOT, label: X.UNIT, parent: null, base: -1, root: true }]
    .concat(data.columns.map((c, k) => ({ id: c.id, label: c.label, parent: c.parent, base: k, merged: c.merged, second: c.second, async: c.async, dependency: c.dependency, independent: c.independent })));
  X.colMs = (i, col, measured) => (col.root ? X.totalMs(i, measured) : X.partMs(i, col.base, measured));

  const clamp = X.clamp;
  function scaleFor(mode, linear, top) {
    if (mode === 'share') {
      if (top > 1) {
        const step = X.niceStep(top, 6), hi = Math.ceil(top / step) * step, ticks = [];
        for (let v = 0; v <= hi; v += step) ticks.push({v, label: `${Math.round(v * 100)}%`});
        return {fwd: (v) => linear ? clamp(v,0,hi) : Math.sqrt(clamp(v,0,hi)), lo:0, hi:linear ? hi : Math.sqrt(hi), ticks};
      }
      if (linear) {
        const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => ({ v, label: v ? `${Math.round(v * 100)}%` : '0' }));
        return { fwd: (v) => clamp(v, 0, 1), lo: 0, hi: 1, ticks };
      }
      const ticks = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1].map((v) => ({ v, label: v ? `${Math.round(v * 100)}%` : '0' }));
      return { fwd: (v) => Math.sqrt(clamp(v, 0, 1)), lo: 0, hi: 1, ticks };
    }
    if (linear) {
      const hi = top * 1.04, step = X.niceStep(hi, 6), ticks = [];
      for (let v = 0; v <= hi; v += step) ticks.push({ v, label: v === 0 ? '0' : v >= 1000 ? `${X.round3(v / 1000)} s` : `${X.round3(v)} ms` });
      return { fwd: (v) => clamp(v, 0, hi), lo: 0, hi, ticks };
    }
    const ticks = [0.01, 0.1, 1, 10, 100, 1000, 10000, 100000].filter((v) => v <= top * 1.6).map((v) => ({ v, label: X.decade(v) }));
    return { fwd: (v) => Math.log10(Math.max(v, X.MS_FLOOR)), lo: Math.log10(X.MS_FLOOR * 0.8), hi: Math.log10(Math.max(top, 0.1) * 1.6), ticks };
  }
  X.valueFn = (cols, mode, measured) => (i, c) => {
    const ms = X.colMs(i, cols[c], measured);
    return mode === 'share' ? ms / X.totalMs(i, measured) : Math.max(X.MS_FLOOR, ms);
  };

  // Occupancy depends only on which units are in view and the columns, so it is kept across measures and scenarios.
  const occCache = new Map();
  X.occupancyOf = (base, units, unitsKey) => {
    const key = `${unitsKey}|${base}`;
    if (!occCache.has(key)) {
      if (occCache.size > 600) occCache.clear();
      occCache.set(key, M.occupancy(data, base, units));
    }
    return occCache.get(key);
  };

  const prepared = new Map(), colCache = new Map();
  X.prepareKey = (mode, linear) => [mode, linear, X.layout.version, X.viewKey(), X.scenarioKey()].join('|');
  X.prepare = (mode, linear) => {
    const key = X.prepareKey(mode, linear);
    if (prepared.has(key)) return prepared.get(key);
    const view = X.unitsInView(true), vk = X.viewKey();
    const cols = X.columnsFor();
    const value = X.valueFn(cols, mode, false);
    let top = 1, above = 0;
    if (mode === 'share') for (const i of view.left.concat(view.right)) for (let c=0;c<cols.length;c++) if(cols[c].async) top = Math.max(top, value(i,c));
    if (mode === 'ms') {
      const all = [];
      for (const i of view.left.concat(view.right)) for (let c = 0; c < cols.length; c++) all.push(value(i, c));
      const sorted = Float64Array.from(all).sort();
      top = Math.max(1, sorted[sorted.length - 1] || 1);
      if (linear) {
        const cut = R.quantile(sorted, 0.998);
        if (cut < top) { top = cut; above = sorted.length - (sorted.findIndex((v) => v > cut) >>> 0); }
      }
    }
    const scale = scaleFor(mode, linear, top);
    scale.above = above;
    const markers = [...view.markers].map(([g, units]) => ({ g, units, shape: 'o', key: `m${X.slotOf(g)}` }));
    // Columns kept between layouts, by what each is made of, the measure, the scale and what is in view; with a
    // what-if, each column's projected time depends on the others, so only within one layout.
    const keyOf = (prefix) => (c) => `${prefix}|${cols[c].root ? 'root' : X.layout.sig(cols[c].id)}|${mode}|${linear}|${vk}|${scale.lo}|${scale.hi}|${proj ? `${X.scenarioKey()}|${X.layout.version}` : ''}`;
    const spec = {
      columns: cols, value, scale, left: view.left, right: view.right, markers, seed: 0, panels: { timeline: true }, cache: colCache, colKey: keyOf('m'),
      occupancy: (c, half) => (cols[c].root ? null : X.occupancyOf(cols[c].base, half === 'left' ? view.left : view.right, `${vk}|${half}`)),
    };
    const model = R.prepareViolins(spec);
    const ghost = proj ? R.prepareViolins(Object.assign({}, spec, { value: X.valueFn(cols, mode, true), markers: [], panels: { timeline: false }, colKey: keyOf('g') })) : null;
    const P = { key, cols, scale, model, ghost, view, vk, mode };
    if (prepared.size > 8) prepared.delete(prepared.keys().next().value);
    prepared.set(key, P);
    return P;
  };
  X.forgetPrepared = () => prepared.clear();

  // ---------------------------------------------------------------------------------------------------------
  // Colours.

  // Each of the first top-level columns gets a hue, kept clear of the halves' blue and orange, and the columns under it
  // its shades; the rest are grey.
  const PART_SHADES = {
    light: { f0: ['#134e4a', '#1f6f68', '#3a9188', '#73b9ae', '#b3dcd3', '#d5ece7'], f1: ['#4b3a99', '#7c69c9', '#9b8ad8', '#cbc0ee', '#e2dcf6'],
      f2: ['#7a5410', '#a8771f', '#c9973d', '#dfbb72', '#efd9a8'], f3: ['#7a1f45', '#a33a63', '#c45f84', '#de97b0', '#efc6d4'],
      other: ['#5d646e', '#8e959f', '#c3c8cf', '#737a84'] },
    dark: { f0: ['#1e6b64', '#2c8a81', '#4aa69c', '#7fc4b9', '#b0dbd3', '#cfe9e4'], f1: ['#6450c0', '#8a78d6', '#a594e3', '#cdc3f1', '#e0daf6'],
      f2: ['#946a1c', '#b3822b', '#c39439', '#dcbc7a', '#ead6a9'], f3: ['#9b2f5a', '#b84a74', '#cf6f92', '#e3a1b8', '#f0c9d6'],
      other: ['#6b727c', '#959ca6', '#c0c5cc', '#80878f'] },
  };
  const familyOf = (k) => (data.partition[k] && data.partition[k].family) || 'other';
  X.T = null;
  X.tokens = () => {
    const cs = getComputedStyle(document.documentElement);
    const t = {};
    for (const k of ['bg', 'surface', 'raised', 'ink', 'muted', 'faint', 'grid', 'band', 'line', 'edge', 'left', 'right', 'm0', 'm1', 'm2', 'm3', 'sel']) {
      t[k] = cs.getPropertyValue(`--${k}`).trim();
    }
    t.scheme = cs.getPropertyValue('--scheme').trim() === 'dark' ? 'dark' : 'light';
    const shades = PART_SHADES[t.scheme];
    t.cols = data.columns.map((c, k) => {
      const list = shades[familyOf(k)];
      const sib = X.parentIdx[k] >= 0 ? X.kids[X.parentIdx[k]].indexOf(k)
        : data.columns.map((_, j) => j).filter((j) => X.parentIdx[j] < 0 && familyOf(j) === familyOf(k)).indexOf(k);
      return list[Math.min(list.length - 1, X.depthIdx[k] + 1 + (sib % 2))];
    });
    // The split of a unit's time: a column's own share in its colour, what no column counts in grey.
    t.parts = data.partition.map((p, k) => (k < data.partition.length - 1 ? t.cols[k] : shades.other[2]));
    t.unowned = t.scheme === 'dark' ? '#3a3f47' : '#d9dde3';
    X.T = t;
    return t;
  };
  X.rgb = (hex) => {
    const c = hex.replace('#', '');
    return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
  };
  X.luminance = (hex) => { const [r, g, b] = X.rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  // The colour of a part of the partition, softened toward the surface so stacks of them read lightly.
  X.partFill = (k) => X.mix(X.T.parts[k], X.T.surface, 0.22);
  // A colour moved a share t of the way to another.
  X.mix = (a, b, t) => {
    const p = X.rgb(a), q = X.rgb(b);
    return `#${p.map((v, k) => Math.round(v + (q[k] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  };
  X.inkOn = (hex) => (X.luminance(hex) < 0.56 ? '#ffffff' : '#171a20');

  // ---------------------------------------------------------------------------------------------------------
  // Text.

  const measure = document.createElement('canvas').getContext('2d');
  X.textWidth = (s, size, weight) => { measure.font = `${weight} ${size}px ${X.SANS}`; return measure.measureText(s).width; };
  X.fitText = (s, size, weight, room) => {
    if (X.textWidth(s, size, weight) <= room) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (X.textWidth(s.slice(0, m) + '…', size, weight) <= room) lo = m; else hi = m - 1; }
    return lo >= 2 ? s.slice(0, lo) + '…' : '';
  };
  X.txt = (x, y, s, o) => `<text x="${X.n1(x)}" y="${X.n1(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.base ? ` dominant-baseline="${o.base}"` : ''}`
    + ` font-family="${X.SANS}" font-size="${o.size || 11.5}"${o.weight ? ` font-weight="${o.weight}"` : ''} fill="${o.fill}"`
    + `${o.tabular ? ' style="font-variant-numeric:tabular-nums"' : ''}${o.extra || ''}>${X.esc(s)}</text>`;

  // The part of a layer w × h CSS px in size that is on screen, and how many device pixels a CSS pixel takes there:
  // the screen's density, times the pinch zoom when zoomed in. Canvases cover just that part at that density, so
  // they stay as sharp as the SVG around them however far one zooms, at the cost of a full screen of pixels.
  // A layer the page zooms itself (zoom: {z, x, y}, a layer point p showing at (x, y) + z·p in el) counts that too.
  X.layerView = (el, w, h, zoom) => {
    const dpr = window.devicePixelRatio || 1, vv = window.visualViewport;
    const k = vv && vv.scale > 1.01 ? Math.min(vv.scale, 8) : 1, z = zoom ? zoom.z : 1;
    if (k === 1 && z === 1) return { x: 0, y: 0, w, h, s: dpr };
    // What shows of el, with a fifth of it to spare on each side, so a small pan shows no edge before the redraw.
    const r = el.getBoundingClientRect();
    let a = 0, b = 0, c = r.width, d = r.height;
    if (k > 1) { a = vv.offsetLeft - r.left; b = vv.offsetTop - r.top; c = a + vv.width; d = b + vv.height; }
    const mx = (c - a) * 0.2, my = (d - b) * 0.2, zx = zoom ? zoom.x : 0, zy = zoom ? zoom.y : 0;
    const x0 = clamp(Math.floor((a - mx - zx) / z), 0, w), y0 = clamp(Math.floor((b - my - zy) / z), 0, h);
    const x1 = clamp(Math.ceil((c + mx - zx) / z), 0, w), y1 = clamp(Math.ceil((d + my - zy) / z), 0, h);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), s: dpr * k * z, z, zx, zy };
  };
  // A canvas over that part of its layer, placed where the zoom shows it; draw on it in layer coordinates after
  // ctx.setTransform(...X.toView(view)).
  X.fitCanvas = (canvas, w, h, view) => {
    const v = view || { x: 0, y: 0, w, h, s: window.devicePixelRatio || 1 }, z = v.z || 1;
    const W = Math.max(1, Math.round(v.w * v.s)), H = Math.max(1, Math.round(v.h * v.s));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    canvas.style.width = `${v.w * z}px`;
    canvas.style.height = `${v.h * z}px`;
    const tx = (v.zx || 0) + v.x * z, ty = (v.zy || 0) + v.y * z;
    canvas.style.transform = tx || ty ? `translate(${tx}px, ${ty}px)` : '';
    return v;
  };
  X.toView = (v) => [v.s, 0, 0, v.s, -v.x * v.s, -v.y * v.s];

  // ---------------------------------------------------------------------------------------------------------
  // Span trees, per file of meta.chunk units.

  const chunks = new Map(), chunkLoads = new Map();
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
  X.chunk = (k) => chunks.get(k);
  // A page downloaded as one file has them all in it already.
  X.loadChunk = (k) => {
    if (chunks.has(k)) return Promise.resolve(chunks.get(k));
    if (!chunkLoads.has(k)) {
      const inPage = (window.EXPLORER_CHUNKS || {})[k];
      chunkLoads.set(k, (inPage ? Promise.resolve() : loadScript(`data/trees-${String(k).padStart(4, '0')}.js`)).then(() => {
        const c = (window.EXPLORER_CHUNKS || {})[k];
        if (!c) throw new Error('empty chunk');
        chunks.set(k, c);
        X.emit('chunk', k);
        return c;
      }, (e) => { chunkLoads.delete(k); throw e; }));
    }
    return chunkLoads.get(k);
  };
  X.chunkCount = Math.ceil(X.NU / (meta.chunk || 200));
  X.chunksLoaded = () => chunks.size;
  // Every file, one after another in the background, the open compilation's first.
  let prefetching = false;
  X.prefetchChunks = () => {
    if (prefetching) return;
    prefetching = true;
    let k = 0;
    const next = () => {
      while (k < X.chunkCount && chunks.has(k)) k++;
      if (k >= X.chunkCount) return;
      X.loadChunk(k++).then(() => setTimeout(next, 0), () => setTimeout(next, 500));
    };
    next();
  };

  // Asynchronous spans go to a track per name, as in Perfetto, in the order the data gives.
  X.TRACKS = meta.async_tracks || [];
  const trackIndex = new Map(X.TRACKS.map((t, k) => [t.name, k]));

  // A compilation's spans: name, parent, start and length in ms from its own start, depth, owning part, and for an
  // asynchronous span other than the root, its track and its lane in it across all compilations; and its links
  // between spans as rows: from, to, and 1 for depends_on, 2 for follows_from.
  const spanCache = new Map();
  X.forgetSpans = () => spanCache.clear();
  // Kept apart from the parsed spans, which are dropped and parsed again: each compilation's highest lane on each
  // track (-1 for none), once its spans are read.
  const trackLanes = new Array(X.NU).fill(null);
  const trackDepths = new Array(X.NU).fill(null);
  X.hasSpans = (unit) => chunks.has(data.units[unit].k);
  X.spanExtent = (unit) => {
    const u = data.units[unit], chunk = chunks.get(u.k);
    return chunk ? X.traceFlows(chunk.trees[unit - u.k * meta.chunk]).extent : [0, u.ms];
  };
  X.trackLanesOf = (unit) => {
    if (!trackLanes[unit] && X.hasSpans(unit)) X.spansOf(unit);
    return trackLanes[unit];
  };
  X.trackDepthsOf = (unit) => {
    if (!trackDepths[unit] && X.hasSpans(unit)) X.spansOf(unit);
    return trackDepths[unit];
  };
  X.spansOf = (unit) => {
    if (spanCache.has(unit)) return spanCache.get(unit);
    const u = data.units[unit], chunk = chunks.get(u.k);
    if (!chunk) return null;
    const tree = chunk.trees[unit - u.k * meta.chunk], flat = tree.rows, n = flat.length / 5, flow = X.traceFlows(tree);
    const rows = new Array(n), top = new Int16Array(X.TRACKS.length).fill(-1);
    const depths = Array.from({length:X.TRACKS.length}, () => []);
    let maxDepth = 0;
    for (let r = 0; r < n; r++) {
      const parent = flat[5 * r + 1], flags = flat[5 * r + 4], name = chunk.names[flat[5 * r]];
      const depth = parent >= 0 ? rows[parent].depth + 1 : 0;
      const async = flow.root[r] > 0, fr = flow.root[r];
      const track = async ? trackIndex.get(chunk.names[flat[5 * fr]]) : -1, lane = async ? flat[5 * fr + 4] >>> 10 : -1;
      if (!async && depth > maxDepth) maxDepth = depth;
      if (async && lane > top[track]) top[track] = lane;
      if (async) depths[track][lane] = Math.max(depths[track][lane] || 0, flow.depth[r] + 1);
      rows[r] = { name, parent, start: flat[5 * r + 2] / 1000, dur: flat[5 * r + 3] / 1000, depth, part: X.layout.partOfRow(unit, r), track, lane, flags,
        flowStart: !!flow.start[r], flowDepth:flow.depth[r], flowRoot:fr, dependency:!!flow.dependency[r] };
    }
    const out = { rows, maxDepth, links: tree.links || [], total: rows[0] ? rows[0].dur : u.ms };
    trackLanes[unit] = top;
    trackDepths[unit] = depths;
    if (spanCache.size > 400) spanCache.clear();
    spanCache.set(unit, out);
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Runs: the inputs the explorer was built from, in the order given. The time views lay them out one after another,
  // each on its own clock, so runs from different days or machines never look concurrent.

  const two = (n) => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  X.RUNS = meta.runs && meta.runs.length ? meta.runs : [{ id: '', label: '', at: 0, units: data.units.length }];
  const runIndex = new Map(X.RUNS.map((r, k) => [r.id, k]));
  X.runOf = (i) => runIndex.get(data.units[i].ds) || 0;
  // Its input's name, when it started and its label: "TPC-H · 26 Oct 17:19 · build fcd8251".
  X.runTitle = (k) => {
    const r = X.RUNS[k], t = new Date((meta.epoch_ms || 0) + r.at);
    return [r.id && X.groupName(r.id), `${t.getDate()} ${MONTHS[t.getMonth()]} ${two(t.getHours())}:${two(t.getMinutes())}`, r.label]
      .filter(Boolean).join(' · ');
  };

  // Display time, for the views that lay compilations out where they ran: the runs one after another with RUN_GAP
  // between them; within each, real time in busy stretches, and each idle stretch over GAP_MIN shown as GAP_SHOWN,
  // marked. units: by run, then in time order. Each run maps its own times: toD(t) and back, toR(d).
  const GAP_MIN = 10000, GAP_SHOWN = 1500, RUN_GAP = 1500;
  function runFold(run, r0, d0) {
    const gaps = [], base = d0 - r0;
    const toD = (t) => {
      let lo = 0, hi = gaps.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (gaps[m].r1 <= t) lo = m + 1; else hi = m; }
      const g = gaps[lo];
      if (g && t > g.r0) return g.d0 + (t - g.r0) / (g.r1 - g.r0) * GAP_SHOWN;
      return t + base - (lo > 0 ? gaps[lo - 1].cut : 0);
    };
    const toR = (d) => {
      let cut = 0;
      for (const g of gaps) {
        if (d < g.d0) break;
        if (d <= g.d1) return g.r0 + (d - g.d0) / GAP_SHOWN * (g.r1 - g.r0);
        cut = g.cut;
      }
      return d - base + cut;
    };
    const fold = (a, b) => {
      const g = { r0: a, r1: b, d0: toD(a) };
      g.d1 = g.d0 + GAP_SHOWN;
      g.cut = (gaps.length ? gaps[gaps.length - 1].cut : 0) + (b - a) - GAP_SHOWN;
      gaps.push(g);
      return g;
    };
    return { run, r0, d0, r1: r0, d1: d0, gaps, toD, toR, fold };
  }
  X.timeFold = (units) => {
    const runs = [], gaps = [];
    let cur = null, end = 0, d = 0;
    const close = () => { if (cur) { cur.r1 = end; cur.d1 = cur.toD(end); d = cur.d1 + RUN_GAP; } };
    for (const i of units) {
      const u = data.units[i], k = X.runOf(i), [lo, hi] = X.spanExtent(i), start = u.at + lo;
      if (!cur || cur.run !== k) {
        close();
        cur = runFold(k, start, d);
        runs.push(cur);
        end = start;
      } else if (start - end > GAP_MIN) gaps.push(cur.fold(end, start));
      end = Math.max(end, u.at + hi);
    }
    close();
    // Where one run ends and the next begins.
    const breaks = runs.slice(1).map((r) => r.d0 - RUN_GAP / 2);
    return { runs, gaps, breaks };
  };

  // Ticks on round values of a duration: 1, 2 or 5 of a power of ten, and minutes and seconds past a second.
  X.tickStep = (span, count) => {
    const raw = span / count;
    if (raw >= 1000) return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000).find((s) => s >= raw) || 3600000;
    return X.niceStep(span, count);
  };
  // Wall-clock time of a moment, with as many decimals of a second as the step has.
  X.clock = (t, step) => {
    const abs = (meta.epoch_ms || 0) + t, sec = Math.floor(abs / 1000 + 1e-9), date = new Date(sec * 1000);
    const base = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
    let dec = 0;
    while (dec < 6 && Math.abs(step / 1000 * 10 ** dec - Math.round(step / 1000 * 10 ** dec)) > 1e-6) dec++;
    return dec ? base + Math.max(0, abs / 1000 - sec).toFixed(dec).slice(1) : base;
  };
  // Each run's title on a time axis d0..d1 across px pixels: where the run starts, or at the left edge while the
  // run is in view; cut short before the line where it ends, left out without room for it.
  X.runLabels = (fold, d0, d1, px) => {
    const xOf = (d) => (d - d0) / (d1 - d0) * px, out = [];
    fold.runs.forEach((r, k) => {
      if (r.d1 < d0 || r.d0 > d1) return;
      const x = Math.max(0, xOf(r.d0)), end = k < fold.breaks.length ? Math.min(px, xOf(fold.breaks[k])) : px;
      const text = X.fitText(X.runTitle(r.run), 11, 500, end - x - 10);
      if (text) out.push({ x, w: X.textWidth(text, 11, 500), text, run: r.run });
    });
    return out;
  };
  // Wall-clock ticks for display times d0..d1 across px pixels: on round times of each run's clock, skipping folded
  // stretches, never crowded, and clear of the runs' labels.
  X.clockTicks = (fold, d0, d1, px, labels) => {
    const epoch = meta.epoch_ms || 0, out = [], xOf = (d) => (d - d0) / (d1 - d0) * px;
    const step = X.tickStep(Math.max(1e-6, d1 - d0), Math.max(2, px / 130));
    let last = -Infinity;
    for (const run of fold.runs) {
      if (run.d1 < d0 || run.d0 > d1) continue;
      const r0 = run.toR(Math.max(d0, run.d0)), r1 = run.toR(Math.min(d1, run.d1));
      for (let v = Math.ceil((epoch + r0) / step) * step - epoch; v <= r1; v += step) {
        const d = run.toD(v);
        const g = run.gaps.find((q) => d > q.d0 && d < q.d1);
        if (g) { v = Math.ceil((epoch + g.r1) / step) * step - epoch - step; continue; }
        const label = X.clock(v, step), x = xOf(d), w = X.textWidth(label, 11, 400);
        if (x - last < w + 18 || (labels && labels.some((l) => x + w + 12 > l.x && x - 8 < l.x + l.w))) continue;
        last = x;
        out.push({ d, label });
      }
    }
    return out;
  };

  // Time since the first compilation in view began, for display times d0..d1 of the timeline model: per run, as each
  // keeps its own clock; on round steps, skipping folded stretches, never crowded, and clear of the runs' labels.
  X.elapsedTicks = (nav, d0, d1, px, labels) => {
    const out = [], xOf = (d) => (d - d0) / (d1 - d0) * px;
    const step = X.tickStep(Math.max(1e-6, d1 - d0), Math.max(2, px / 110));
    let last = -Infinity;
    for (const run of nav.runs) {
      if (run.d1 < d0 || run.d0 > d1) continue;
      let origin = null;
      for (const i of nav.units) if (X.runOf(i) === run.run && nav.start[i] + data.units[i].ms >= d0) { origin = data.units[i].at; break; }
      if (origin === null) continue;
      const r0 = run.toR(Math.max(d0, run.d0)), r1 = run.toR(Math.min(d1, run.d1));
      for (let v = origin + Math.max(0, Math.ceil((r0 - origin) / step)) * step; v <= r1; v += step) {
        const d = run.toD(v);
        const g = run.gaps.find((q) => d > q.d0 && d < q.d1);
        if (g) { v = origin + Math.ceil((g.r1 - origin) / step) * step - step; continue; }
        const label = v === origin ? '0' : `+${X.fmtSpan(v - origin, step)}`, x = xOf(d), w = X.textWidth(label, 11, 400);
        if (x - last < w + 18 || (labels && labels.some((l) => x + w + 12 > l.x && x - 8 < l.x + l.w))) continue;
        last = x;
        out.push({ d, label });
      }
    }
    return out;
  };

  // ---------------------------------------------------------------------------------------------------------
  // A tiny event bus between views.

  const handlers = new Map();
  X.on = (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); };
  X.emit = (e, arg) => { for (const f of handlers.get(e) || []) f(arg); };

  // No columns until the spans are read.
  X.reindex();
})();
