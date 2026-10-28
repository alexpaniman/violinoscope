// Canvas renderer for the explorer's figures. It mirrors the matplotlib figures it replaced: sizes are in points
// and figure inches, placed with the same axes boxes, so a figure drawn at 150 px per inch matches the reference
// render pixel for pixel apart from anti-aliasing and the random spread of dots.
(function () {
  'use strict';

  const FONT = "'Explorer DejaVu', 'DejaVu Sans', Verdana, sans-serif";
  const THEMES = {
    light: { bg: '#ffffff', ink: '#1d1d1f', muted: '#6e6e73', grid: '#e4e4e8', band: '#f6f6f8', tree: '#e9e9ee',
      left: '#2a78d6', right: '#eb6834', m0: '#1baf7a', m1: '#6250d6', m2: '#c98500', m3: '#e34948', select: '#1d1d1f' },
    dark: { bg: '#1b1b1d', ink: '#f2f2f5', muted: '#a3a3a8', grid: '#38383c', band: '#222225', tree: '#2e2e33',
      left: '#3987e5', right: '#d95926', m0: '#199e70', m1: '#9085e9', m2: '#c98500', m3: '#e66767', select: '#f2f2f5' },
  };
  // Non-overlapping parts: hue by stage of the pipeline, shade by part within it.
  const FAMILY_SHADES = {
    light: { front: ['#0e3d8a', '#1f5ebd', '#3b80dc', '#78a9ea', '#b6d1f4', '#d6e5f9'], logical: ['#17885a', '#7ccfa9', '#b7e6cf'],
      physical: ['#a8410f', '#eb6834', '#f6ad85', '#f9cdb3'], other: ['#9a9aa0', '#5e5e64', '#cfcfd4', '#7c7c82'] },
    dark: { front: ['#2f63b8', '#3f7fd6', '#5e9bec', '#8fb8f0', '#c2d8f6', '#dbe8fa'], logical: ['#1f9e6a', '#86d8b3', '#bde9d3'],
      physical: ['#b9531e', '#ec7a4a', '#f5b693', '#f8d0b8'], other: ['#8a8a90', '#626268', '#b3b3b9', '#76767c'] },
  };
  const HALF = 0.42;
  const BINS = 200;

  // ---------------------------------------------------------------------------------------------------------
  // Numbers.

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The n-th term of the base-2 van der Corput sequence: 1/2, 1/4, 3/4, 1/8, 5/8, ...
  function vanDerCorput(n) {
    let v = 0, d = 1;
    while (n) { d *= 2; v += (n & 1) / d; n >>>= 1; }
    return v;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // Gaussian kernel density with Scott's bandwidth (as scipy's gaussian_kde), evaluated through a fine histogram.
  function kde(us) {
    const n = us.length;
    if (n < 3) return null;
    let mean = 0;
    for (const u of us) mean += u;
    mean /= n;
    let v = 0, lo = Infinity, hi = -Infinity;
    for (const u of us) { v += (u - mean) ** 2; if (u < lo) lo = u; if (u > hi) hi = u; }
    const sd = Math.sqrt(v / (n - 1));
    if (sd < 1e-6) return null;
    const bw = sd * Math.pow(n, -0.2);
    const B = 512, a = lo - 4 * bw, b = hi + 4 * bw, step = (b - a) / B;
    const counts = new Float64Array(B);
    for (const u of us) counts[Math.min(B - 1, Math.max(0, Math.floor((u - a) / step)))] += 1;
    const at = (x) => {
      let s = 0;
      const k0 = Math.max(0, Math.floor((x - 5 * bw - a) / step)), k1 = Math.min(B - 1, Math.ceil((x + 5 * bw - a) / step));
      for (let k = k0; k <= k1; k++) {
        if (!counts[k]) continue;
        const d = (x - (a + (k + 0.5) * step)) / bw;
        s += counts[k] * Math.exp(-0.5 * d * d);
      }
      return s;
    };
    const span = hi - lo, g0 = lo - 0.02 * span, g1 = hi + 0.02 * span, N = 220;
    const grid = new Float64Array(N), dens = new Float64Array(N);
    let peak = 0;
    for (let i = 0; i < N; i++) {
      grid[i] = g0 + (g1 - g0) * i / (N - 1);
      dens[i] = at(grid[i]);
      if (dens[i] > peak) peak = dens[i];
    }
    for (let i = 0; i < N; i++) dens[i] /= peak;
    // The width at a value, read off the outline itself (straight between grid points, as it is drawn), so points
    // placed by it stay inside it.
    const width = (u) => {
      const x = (u - g0) / (g1 - g0) * (N - 1);
      if (!(x > 0)) return dens[0];
      if (x >= N - 1) return dens[N - 1];
      const k = Math.floor(x), f = x - k;
      return dens[k] * (1 - f) + dens[k + 1] * f;
    };
    return { grid, dens, width };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Text.

  function setFont(ctx, pt, scale, weight) {
    ctx.font = `${weight || 400} ${pt * scale}px ${FONT}`;
  }

  function text(ctx, str, x, y, o) {
    setFont(ctx, o.size, o.scale, o.weight);
    ctx.fillStyle = o.color;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    if (o.rotate) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(o.rotate);
      ctx.fillText(str, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(str, x, y);
    }
  }

  // Lines of a multi-line label, top-aligned at y: matplotlib's line height is about 1.05 em times the line spacing.
  function textLines(ctx, lines, x, y, o) {
    const lh = o.size * o.scale * 1.05 * (o.linespacing || 1.2);
    lines.forEach((line, i) => text(ctx, line, x, y + i * lh, Object.assign({}, o, { baseline: 'top' })));
    return lines.length * lh;
  }

  function wrap(label, width) {
    const words = label.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      if (line && (line + ' ' + w).length > width) { lines.push(line); line = w; } else { line = line ? line + ' ' + w : w; }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Wraps by measured width in the context's current font. A word more than 6% wider than that is hyphenated,
  // leaving at least four letters for the next line.
  function wrapMeasured(ctx, label, maxPx) {
    const lines = [];
    let line = '';
    const add = (w) => {
      if (line && ctx.measureText(line + ' ' + w).width > maxPx) { lines.push(line); line = w; } else { line = line ? line + ' ' + w : w; }
    };
    for (let w of label.split(' ')) {
      while (w.length > 7 && ctx.measureText(w).width > maxPx * 1.06) {
        let k = w.length - 4;
        while (k > 3 && ctx.measureText(w.slice(0, k) + '-').width > maxPx) k--;
        add(w.slice(0, k) + '-');
        lines.push(line);
        line = '';
        w = w.slice(k);
      }
      add(w);
    }
    if (line) lines.push(line);
    return lines;
  }

  // The label cut with an ellipsis to fit maxPx, in the context's current font.
  function fitText(ctx, label, maxPx) {
    if (ctx.measureText(label).width <= maxPx) return label;
    let s = label;
    while (s.length > 1 && ctx.measureText(s + '…').width > maxPx) s = s.slice(0, -1);
    return s.length > 1 ? s.trimEnd() + '…' : '';
  }

  // ---------------------------------------------------------------------------------------------------------
  // Shapes.

  function marker(ctx, shape, x, y, sizePx, fill, edge, edgeWidth) {
    ctx.beginPath();
    // matplotlib's geometry: 's' is a square of side `size`, 'D' the same square turned by 45 degrees.
    if (shape === 'D') {
      const r = sizePx * Math.SQRT1_2;
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
    } else if (shape === 's') {
      const h = sizePx / 2;
      ctx.rect(x - h, y - h, 2 * h, 2 * h);
    } else if (shape === '^') {
      const h = sizePx * 0.55;
      ctx.moveTo(x, y - h); ctx.lineTo(x + h, y + h * 0.75); ctx.lineTo(x - h, y + h * 0.75); ctx.closePath();
    } else {
      ctx.arc(x, y, sizePx / 2, 0, Math.PI * 2);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    if (edge && edgeWidth) {
      ctx.lineWidth = edgeWidth;
      ctx.strokeStyle = edge;
      ctx.stroke();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hexAlpha(color, alpha) {
    const c = color.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function luminance(color) {
    const c = color.replace('#', '');
    return (0.2126 * parseInt(c.slice(0, 2), 16) + 0.7152 * parseInt(c.slice(2, 4), 16) + 0.0722 * parseInt(c.slice(4, 6), 16)) / 255;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Violins: prepare once per data and view, draw at any size.

  // spec: { columns: [{id, label, parent}], value(u, c), scale: {fwd, ticks: [{v, label}], lo, hi, axis, head, headLabel},
  //   left: [unit], right: [unit], markers: [{units, shape, key, label}], legend: [...], occupancy(c, half) -> Float64Array|null,
  //   panels: {tree, timeline}, seed }
  function prepareViolins(spec) {
    const n = spec.columns.length;
    const model = { spec, n, cols: [] };
    for (let c = 0; c < n; c++) {
      const col = { halves: {} };
      for (const [half, side] of [['left', -1], ['right', 1]]) {
        const units = spec[half];
        const v = new Float64Array(units.length), u = new Float64Array(units.length);
        const finite = [];
        for (let i = 0; i < units.length; i++) {
          v[i] = spec.value(units[i], c);
          u[i] = spec.scale.fwd(v[i]);
          if (Number.isFinite(u[i])) finite.push(u[i]);
        }
        const density = kde(finite);
        // Points spread across the violin's width at their value, quasirandomly as in a sina plot: in order of
        // value, each takes the next term of the van der Corput sequence, so neighbours fill the width evenly
        // instead of clumping. w is the width there (1 at the widest), q the place across it.
        const w = new Float64Array(units.length), q = new Float64Array(units.length);
        if (density) {
          const order = Array.from(units.keys()).filter((i) => Number.isFinite(u[i])).sort((a, b) => u[a] - u[b]);
          order.forEach((i, rank) => { w[i] = density.width(u[i]); q[i] = vanDerCorput(rank + 1); });
        }
        // In column widths, for the canvas renderer.
        const dx = w.map((wi, i) => side * (0.04 + 0.92 * q[i]) * wi * HALF);
        const sorted = Array.from(v).filter(Number.isFinite).sort((a, b) => a - b);
        col.halves[half] = { units, v, u, w, q, dx, density, median: quantile(sorted, 0.5), side };
      }
      col.markers = (spec.markers || []).map((m) => ({ m, v: m.units.map((unit) => spec.value(unit, c)) }));
      col.occupancy = spec.panels.timeline ? { left: spec.occupancy(c, 'left'), right: spec.occupancy(c, 'right') } : null;
      model.cols.push(col);
    }
    return model;
  }

  function depthOf(columns) {
    const index = new Map(columns.map((c, i) => [c.id, i]));
    return columns.map((c) => {
      let d = 0, p = c.parent;
      while (p && index.has(p)) { d++; p = columns[index.get(p)].parent; }
      return d;
    });
  }

  function subtreeEnd(columns) {
    const index = new Map(columns.map((c, i) => [c.id, i]));
    const end = columns.map((_, i) => i);
    columns.forEach((c, i) => {
      let p = c.parent;
      while (p && index.has(p)) { end[index.get(p)] = i; p = columns[index.get(p)].parent; }
    });
    return end;
  }

  function violinLayout(spec) {
    if (spec.layout) return Object.assign({ TREE: [0, 0, 0, 0], TIME: [0, 0, 0, 0], legendY: 0.995 }, spec.layout);
    const n = spec.columns.length;
    const full = spec.panels.tree || spec.panels.timeline;
    return {
      figW: Math.max(15, 18 * n / 22), figH: full ? 11.5 : 7.2,  // fewer columns get wider, not larger text
      V: full ? [0.055, 0.405, 0.935, 0.505] : [0.055, 0.17, 0.935, 0.74],
      TREE: [0.055, 0.285, 0.935, 0.058],
      TIME: [0.055, 0.03, 0.935, 0.235],
      legendY: 0.995,
    };
  }

  // Deepest "part of" row the tree panel draws: parents, and parents folded into one column.
  function treeDepth(spec) {
    const depth = depthOf(spec.columns), ends = subtreeEnd(spec.columns);
    let max = -1;
    spec.columns.forEach((c, i) => { if (ends[i] > i || (spec.collapsed && spec.collapsed.has(i))) max = Math.max(max, depth[i]); });
    return max;
  }

  // A layout filling w × h px at `scale` px per point, keeping the reference figure's margins in points. Column
  // labels wrap to the column width and shrink, down to 7.4 pt, so that the longest word fits; past that it is
  // hyphenated.
  function fitLayout(ctx, spec, wPx, hPx, scale) {
    const n = spec.columns.length;
    const Wp = wPx / scale, Hp = hPx / scale;
    const left = 72, right = 10;
    const room = (Wp - left - right) / (n + 0.2) * 0.98;
    setFont(ctx, 8.1, 1);
    let widest = 0;
    for (const c of spec.columns) for (const w of c.label.split(' ')) widest = Math.max(widest, ctx.measureText(w).width);
    const size = widest > room ? Math.max(7.4, 8.1 * room / widest) : 8.1;
    setFont(ctx, size, scale);
    const labelLines = spec.columns.map((c) => wrapMeasured(ctx, c.label, room * scale));
    const lines = Math.max(1, ...labelLines.map((l) => l.length));
    const labels = 9.4 + lines * size * 1.05 * 1.1 + 4;
    const rows = spec.panels.tree ? treeDepth(spec) + 1 : 0;
    const tree = rows ? (rows + 0.2) * 15 : 0;
    const time = spec.panels.timeline;
    const top = 48, gap = time ? 14 : 0, bottom = time ? 6 : 4;
    const avail = Math.max(80, Hp - top - labels - tree - gap - bottom);
    const vH = time ? avail * 0.64 : avail, tH = time ? avail - vH : 0;
    const fx = (pt) => pt / Wp, fy = (pt) => pt / Hp, width = fx(Wp - left - right);
    return {
      figW: Wp / 72, figH: Hp / 72, labelLines, labelSize: size,
      V: [fx(left), fy(bottom + tH + gap + tree + labels), width, fy(vH)],
      TREE: [fx(left), fy(bottom + tH + gap), width, fy(tree)],
      TIME: [fx(left), fy(bottom), width, fy(tH)],
      legendY: 1 - 4 / Hp,
    };
  }

  // Draws the figure into ctx at `scale` px per point. opts: {theme, highlight: Set of units or null, labelScale}.
  function drawViolins(ctx, model, scale, opts) {
    const t = THEMES[opts.theme];
    const spec = model.spec, n = model.n, L = violinLayout(spec);
    const W = L.figW * 72 * scale, H = L.figH * 72 * scale, pt = scale;
    const box = (b) => ({ x0: b[0] * W, x1: (b[0] + b[2]) * W, y0: (1 - b[1] - b[3]) * H, y1: (1 - b[1]) * H });
    const ax = box(L.V);
    const xOf = (x) => ax.x0 + (x + 0.6) / (n + 0.2) * (ax.x1 - ax.x0);  // x limits are (-0.6, n - 0.4)
    const ulo = spec.scale.lo, uhi = spec.scale.hi;
    const yOfU = (u) => ax.y1 - (u - ulo) / (uhi - ulo) * (ax.y1 - ax.y0);
    const colW = xOf(1) - xOf(0);
    const depth = depthOf(spec.columns), ends = subtreeEnd(spec.columns);
    const roots = spec.columns.map((c, i) => i).filter((i) => !spec.columns[i].parent);
    const bandDepth = roots.length === 1 ? 1 : 0;
    const bands = spec.columns.map((c, i) => i).filter((i) => depth[i] === bandDepth);

    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);

    // Axes background: bands and grid.
    bands.forEach((i, k) => {
      if (k % 2) return;
      ctx.fillStyle = t.band;
      ctx.fillRect(xOf(i - 0.5), ax.y0, xOf(ends[i] + 0.5) - xOf(i - 0.5), ax.y1 - ax.y0);
    });
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 0.6 * pt;
    for (const tick of spec.scale.ticks.slice(1)) {
      const y = yOfU(spec.scale.fwd(tick.v));
      ctx.beginPath(); ctx.moveTo(ax.x0, y); ctx.lineTo(ax.x1, y); ctx.stroke();
    }

    // Violins, dots, medians.
    const highlight = opts.highlight && opts.highlight.size ? opts.highlight : null;
    const geometry = { W, H, scale, ax, xOf, yOfU, colW, half: HALF * colW, points: [], labels: [], timeline: null, columns: [] };
    ctx.save();
    ctx.beginPath();
    ctx.rect(ax.x0, ax.y0, ax.x1 - ax.x0, ax.y1 - ax.y0);
    ctx.clip();
    for (let c = 0; c < n; c++) {
      const col = model.cols[c];
      const pts = { x: [], y: [], unit: [] };
      for (const half of ['left', 'right']) {
        const h = col.halves[half];
        const color = t[half];
        if (h.density) {
          const g = h.density;
          ctx.beginPath();
          ctx.moveTo(xOf(c), yOfU(g.grid[0]));
          for (let i = 0; i < g.grid.length; i++) ctx.lineTo(xOf(c + h.side * g.dens[i] * HALF), yOfU(g.grid[i]));
          ctx.lineTo(xOf(c), yOfU(g.grid[g.grid.length - 1]));
          ctx.closePath();
          ctx.fillStyle = hexAlpha(color, 0.16);
          ctx.fill();
          ctx.beginPath();
          for (let i = 0; i < g.grid.length; i++) {
            const x = xOf(c + h.side * g.dens[i] * HALF), y = yOfU(g.grid[i]);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.strokeStyle = hexAlpha(color, 0.75);
          ctx.lineWidth = 0.9 * pt;
          ctx.stroke();
        }
      }
      for (const half of ['left', 'right']) {
        const h = col.halves[half];
        const big = half === 'right';
        const r = Math.sqrt(big ? 9 : 2.2) / 2 * pt;
        const alpha = big ? 0.85 : 0.32;
        ctx.fillStyle = hexAlpha(t[half], highlight ? alpha * 0.22 : alpha);
        for (let i = 0; i < h.units.length; i++) {
          if (!Number.isFinite(h.u[i])) continue;
          const x = xOf(c + h.dx[i]), y = yOfU(Math.max(ulo, Math.min(uhi, h.u[i])));
          pts.x.push(x); pts.y.push(y); pts.unit.push(h.units[i]);
          if (highlight && highlight.has(h.units[i])) continue;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        }
        if (highlight) {
          ctx.fillStyle = hexAlpha(t[half], 0.95);
          for (let i = 0; i < h.units.length; i++) {
            if (!highlight.has(h.units[i]) || !Number.isFinite(h.u[i])) continue;
            const x = xOf(c + h.dx[i]), y = yOfU(Math.max(ulo, Math.min(uhi, h.u[i])));
            ctx.beginPath(); ctx.arc(x, y, Math.max(r * 1.5, 1.6 * pt), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.restore();
      for (const half of ['left', 'right']) {
        const h = col.halves[half];
        if (!Number.isFinite(h.median)) continue;
        const y = yOfU(spec.scale.fwd(h.median));
        ctx.strokeStyle = t.ink;
        ctx.lineWidth = 1.6 * pt;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(xOf(c), y); ctx.lineTo(xOf(c + h.side * HALF * 0.9), y); ctx.stroke();
        ctx.lineCap = 'butt';
        text(ctx, spec.scale.headLabel(h.median), xOf(c + h.side * 0.06), ax.y0 - 0.035 * (ax.y1 - ax.y0),
          { size: 8.4, scale, weight: 700, color: t[half], align: h.side < 0 ? 'right' : 'left', baseline: 'bottom' });
      }
      col.markers.forEach(({ m, v }) => {
        v.forEach((value, k) => {
          const u = spec.scale.fwd(value);
          if (!Number.isFinite(u)) return;
          const x = xOf(c), y = yOfU(Math.max(ulo, Math.min(uhi, u)));
          marker(ctx, m.shape, x, y, Math.sqrt(34) * pt, t[m.key], t.bg, 1.2 * pt);
          pts.x.push(x); pts.y.push(y); pts.unit.push(m.units[k]);
        });
      });
      geometry.points.push({ x: Float32Array.from(pts.x), y: Float32Array.from(pts.y), unit: Int32Array.from(pts.unit) });
      geometry.columns.push(xOf(c));
      if (c < n - 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ax.x0, ax.y0, ax.x1 - ax.x0, ax.y1 - ax.y0);
        ctx.clip();
      }
    }
    text(ctx, spec.scale.head, ax.x0, ax.y0 - 0.035 * (ax.y1 - ax.y0), { size: 8.4, scale, color: t.muted, align: 'right', baseline: 'bottom' });

    // Spines, y ticks and labels.
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 0.8 * pt;
    ctx.beginPath(); ctx.moveTo(ax.x0, ax.y0); ctx.lineTo(ax.x0, ax.y1); ctx.lineTo(ax.x1, ax.y1); ctx.stroke();
    let widest = 0;
    setFont(ctx, 9, scale);
    for (const tick of spec.scale.ticks) widest = Math.max(widest, ctx.measureText(tick.label).width);
    ctx.strokeStyle = t.muted;
    for (const tick of spec.scale.ticks) {
      const y = yOfU(spec.scale.fwd(tick.v));
      ctx.lineWidth = 0.8 * pt;
      ctx.beginPath(); ctx.moveTo(ax.x0, y); ctx.lineTo(ax.x0 - 3.5 * pt, y); ctx.stroke();
      text(ctx, tick.label, ax.x0 - 7 * pt, y, { size: 9, scale, color: t.muted, align: 'right', baseline: 'middle' });
    }
    text(ctx, spec.scale.axis, ax.x0 - 7 * pt - widest - 4 * pt, (ax.y0 + ax.y1) / 2,
      { size: 9, scale, color: t.muted, align: 'center', baseline: 'bottom', rotate: -Math.PI / 2 });

    // Column labels.
    for (let c = 0; c < n; c++) {
      const lines = L.labelLines ? L.labelLines[c] : wrap(spec.columns[c].label, 11);
      const hgt = textLines(ctx, lines, xOf(c), ax.y1 + 9.4 * pt, { size: (L.labelSize || 8.1) * (opts.labelScale || 1), scale, color: t.ink, align: 'center', linespacing: 1.1 });
      geometry.labels.push({ x0: xOf(c - 0.5), x1: xOf(c + 0.5), y0: ax.y1 + 2 * pt, y1: ax.y1 + 6 * pt + hgt });
    }

    // Legend.
    legend(ctx, spec.legend, L.V[0] * W, (1 - L.legendY) * H, scale, t, 9.5, 1.4, 1.8, true);

    // "Part of" bars; a parent folded into one column gets an outlined bar saying how many parts it holds.
    geometry.bars = [];
    if (spec.panels.tree) {
      const tb = box(L.TREE);
      const parents = spec.columns.map((c, i) => i).filter((i) => ends[i] > i);
      const maxDepth = Math.max(0, treeDepth(spec));
      const rowY = (d) => tb.y0 + (d + 0.6) / (maxDepth + 1.2) * (tb.y1 - tb.y0);
      const rowH = (tb.y1 - tb.y0) / (maxDepth + 1.2);
      for (const i of parents) {
        const d = depth[i], j = ends[i];
        const x0 = xOf(i - 0.44), x1 = xOf(j + 0.44), y0 = rowY(d) - 0.34 * rowH;
        ctx.fillStyle = t.tree;
        roundRect(ctx, x0, y0, x1 - x0, 0.68 * rowH, 0.12 * rowH * 1.6);
        ctx.fill();
        setFont(ctx, 8.6, scale);
        text(ctx, fitText(ctx, spec.columns[i].label, x1 - x0), (xOf(i) + xOf(j)) / 2, rowY(d), { size: 8.6, scale, color: t.ink, align: 'center', baseline: 'middle' });
        geometry.bars.push({ c: i, folded: false, x0, x1, y0, y1: y0 + 0.68 * rowH });
      }
      for (const [i, count] of spec.collapsed || []) {
        const x0 = xOf(i - 0.44), x1 = xOf(i + 0.44), y0 = rowY(depth[i]) - 0.34 * rowH;
        ctx.strokeStyle = t.muted;
        ctx.lineWidth = 0.8 * pt;
        ctx.setLineDash([2.5 * pt, 2 * pt]);
        roundRect(ctx, x0, y0, x1 - x0, 0.68 * rowH, 0.12 * rowH * 1.6);
        ctx.stroke();
        ctx.setLineDash([]);
        text(ctx, `+${count}`, xOf(i), rowY(depth[i]), { size: 8.6, scale, color: t.muted, align: 'center', baseline: 'middle' });
        geometry.bars.push({ c: i, folded: true, x0, x1, y0, y1: y0 + 0.68 * rowH });
      }
      if (parents.length || (spec.collapsed && spec.collapsed.size)) {
        text(ctx, 'part of', ax.x0, rowY(0), { size: 8.4, scale, color: t.muted, align: 'right', baseline: 'middle' });
      }
    }

    if (spec.panels.timeline) {
      const tl = box(L.TIME);
      geometry.timeline = tl;
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 0.6 * pt;
      for (const v of [0.25, 0.5, 0.75]) {
        const y = tl.y0 + v * (tl.y1 - tl.y0);
        ctx.beginPath(); ctx.moveTo(tl.x0, y); ctx.lineTo(tl.x1, y); ctx.stroke();
      }
      const rowH = (tl.y1 - tl.y0) / BINS;
      for (let c = 0; c < n; c++) {
        const occ = model.cols[c].occupancy;
        if (!occ) continue;
        for (const [half, x0] of [['left', c - HALF], ['right', c]]) {
          const o = occ[half];
          if (!o) continue;
          const xa = xOf(x0), xb = xOf(x0 + HALF);
          for (let b = 0; b < BINS; b++) {
            if (o[b] <= 0) continue;
            ctx.fillStyle = hexAlpha(t[half], Math.pow(Math.min(1, o[b]), 0.6) * 0.95);
            ctx.fillRect(xa, tl.y0 + b * rowH, xb - xa, rowH + 0.5);
          }
        }
        ctx.strokeStyle = t.grid;
        ctx.lineWidth = 0.6 * pt;
        ctx.strokeRect(xOf(c - HALF), tl.y0, xOf(c + HALF) - xOf(c - HALF), tl.y1 - tl.y0);
      }
      ctx.strokeStyle = t.grid;
      ctx.lineWidth = 0.8 * pt;
      ctx.beginPath(); ctx.moveTo(tl.x0, tl.y0); ctx.lineTo(tl.x0, tl.y1); ctx.stroke();
      const labels = [['start', 0], ['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['end', 1]];
      let w = 0;
      setFont(ctx, 9, scale);
      for (const [label] of labels) w = Math.max(w, ctx.measureText(label).width);
      ctx.strokeStyle = t.muted;
      for (const [label, v] of labels) {
        const y = tl.y0 + v * (tl.y1 - tl.y0);
        ctx.beginPath(); ctx.moveTo(tl.x0, y); ctx.lineTo(tl.x0 - 3.5 * pt, y); ctx.stroke();
        text(ctx, label, tl.x0 - 7 * pt, y, { size: 9, scale, color: t.muted, align: 'right', baseline: 'middle' });
      }
      const lx = tl.x0 - 7 * pt - w - 4 * pt;
      const lh = 9 * scale * 1.2 * 1.2;
      text(ctx, '(compile timeline, top to bottom)', lx, (tl.y0 + tl.y1) / 2, { size: 9, scale, color: t.muted, align: 'center', baseline: 'bottom', rotate: -Math.PI / 2 });
      text(ctx, 'when it runs', lx - lh, (tl.y0 + tl.y1) / 2, { size: 9, scale, color: t.muted, align: 'center', baseline: 'bottom', rotate: -Math.PI / 2 });
    }
    return geometry;
  }

  // items: [{label, kind: 'patch'|'marker', key, alpha, shape}]
  function legend(ctx, items, x, y, scale, t, size, handleLength, columnSpacing, horizontal, rowSpacing) {
    const fs = size * scale;
    let cx = x + 0.9 * fs, cy = y + 0.9 * fs;
    setFont(ctx, size, scale);
    const rowH = fs * (1 + (rowSpacing === undefined ? 0.5 : rowSpacing));
    for (const item of items) {
      const color = t[item.key] || item.color;
      const hw = handleLength * fs, hh = 0.7 * fs;
      const mid = cy + fs * 0.5;
      if (item.kind === 'marker') {
        marker(ctx, item.shape, cx + hw / 2, mid, 6 * scale, color, null, 0);
      } else {
        ctx.fillStyle = item.alpha !== undefined ? hexAlpha(color, item.alpha) : color;
        ctx.fillRect(cx, mid - hh / 2, hw, hh);
      }
      text(ctx, item.label, cx + hw + 0.8 * fs, mid, { size, scale, color: t.ink, baseline: 'middle' });
      setFont(ctx, size, scale);
      const w = hw + 0.8 * fs + ctx.measureText(item.label).width;
      if (horizontal) cx += w + columnSpacing * fs; else cy += rowH;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Dominance: kernel-weighted mean share of each non-overlapping part against total time.

  const D = { W: 18, H: 8, COUNT: [0.055, 0.80, 0.80, 0.13], MAIN: [0.055, 0.08, 0.80, 0.69], GRID: 240, BW: 0.06, MIN_N: 12 };

  // units: [{ms, p: [shares]}], halves: {left: [i], right: [i]}, variant: 'all'|'left'|'right'
  function prepareDominance(units, halves, variant, nParts, globalRange) {
    const pick = variant === 'all' ? halves.left.concat(halves.right) : halves[variant];
    const logs = pick.map((i) => Math.log10(Math.max(units[i].ms, 1e-3)));
    const [g0, g1] = globalRange;
    const grid = new Float64Array(D.GRID);
    for (let j = 0; j < D.GRID; j++) grid[j] = g0 + (g1 - g0) * j / (D.GRID - 1);
    const mean = [], ms = [], neff = new Float64Array(D.GRID), ok = new Uint8Array(D.GRID);
    // Where compilations are few, the kernel widens until it covers enough of them (up to a decade either way), so the
    // shares run smoothly to both ends; `wide` marks where it had to.
    const wide = new Uint8Array(D.GRID);
    for (let j = 0; j < D.GRID; j++) {
      let sw = 0, sw2 = 0, acc, accMs;
      for (let bw = D.BW; ; bw *= 1.6) {
        sw = 0; sw2 = 0;
        acc = new Float64Array(nParts); accMs = new Float64Array(nParts);
        for (let k = 0; k < pick.length; k++) {
          const d = (grid[j] - logs[k]) / bw;
          if (d > 6 || d < -6) continue;
          const w = Math.exp(-0.5 * d * d);
          sw += w; sw2 += w * w;
          const u = units[pick[k]];
          for (let p = 0; p < nParts; p++) { acc[p] += w * u.p[p]; accMs[p] += w * u.p[p] * u.ms; }
        }
        if ((sw2 > 0 && sw * sw / sw2 >= D.MIN_N) || bw > 1) { wide[j] = bw > D.BW * 2 ? 1 : 0; break; }
      }
      for (let p = 0; p < nParts; p++) { acc[p] /= sw || 1; accMs[p] /= sw || 1; }
      // Shares are rounded per unit; renormalize so the bands meet the top.
      let total = 0;
      for (let p = 0; p < nParts; p++) total += acc[p];
      if (total > 0) for (let p = 0; p < nParts; p++) acc[p] /= total;
      mean.push(acc); ms.push(accMs);
      neff[j] = sw2 > 0 ? sw * sw / sw2 : 0;
      ok[j] = neff[j] >= D.MIN_N ? 1 : 0;
    }
    return { grid, mean, ms, neff, ok, wide, count: pick.length, logs: { left: halves.left.map((i) => Math.log10(Math.max(units[i].ms, 1e-3))),
      right: halves.right.map((i) => Math.log10(Math.max(units[i].ms, 1e-3))) } };
  }

  function labelSpot(grid, lo, hi, ok, halfWidth) {
    let best = 0, spot = -1, middle = 0, first = -1, last = -1;
    for (let j = 0; j < grid.length; j++) if (ok[j]) { if (first < 0) first = j; last = j; }
    if (first < 0) return { spot: -1 };
    const left = grid[first] + halfWidth, right = grid[last] - halfWidth;
    for (let j = 0; j < grid.length; j++) {
      if (grid[j] < left || grid[j] > right) continue;
      let minHi = Infinity, maxLo = -Infinity;
      for (let k = 0; k < grid.length; k++) {
        if (Math.abs(grid[k] - grid[j]) > halfWidth) continue;
        minHi = Math.min(minHi, hi[k]); maxLo = Math.max(maxLo, lo[k]);
      }
      if (minHi - maxLo > best) { best = minHi - maxLo; spot = j; middle = (minHi + maxLo) / 2; }
    }
    return { spot, room: best, middle };
  }

  // A dominance layout filling w × h px at `scale` px per point, for a narrow panel: no legend inside the figure.
  function fitDominance(wPx, hPx, scale) {
    const Wp = wPx / scale, Hp = hPx / scale;
    const left = 50, right = 8, top = 6, count = 46, gap = 10, bottom = 40;
    const width = (Wp - left - right) / Wp;
    return { W: Wp / 72, H: Hp / 72, legend: false,
      COUNT: [left / Wp, (Hp - top - count) / Hp, width, count / Hp],
      MAIN: [left / Wp, bottom / Hp, width, (Hp - top - count - gap - bottom) / Hp] };
  }

  // parts: [{id, label, family}], xlim: [lo, hi] in ms, markers: [{log, shape, key}]; opts.layout as fitDominance's.
  function drawDominance(ctx, model, parts, xlim, scale, opts) {
    const t = THEMES[opts.theme], shades = FAMILY_SHADES[opts.theme];
    const Lay = opts.layout || D;
    const W = Lay.W * 72 * scale, H = Lay.H * 72 * scale, pt = scale;
    const box = (b) => ({ x0: b[0] * W, x1: (b[0] + b[2]) * W, y0: (1 - b[1] - b[3]) * H, y1: (1 - b[1]) * H });
    const colors = partColors(parts, shades);
    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, W, H);
    const lx0 = Math.log10(xlim[0]), lx1 = Math.log10(xlim[1]);
    const hc = box(Lay.COUNT), ax = box(Lay.MAIN);
    const xOf = (lg) => ax.x0 + (lg - lx0) / (lx1 - lx0) * (ax.x1 - ax.x0);

    // Query counts per log bin, each half, log scale.
    const edges = [];
    for (let e = Math.floor(lx0 * 20) / 20; e <= lx1 + 0.05; e += 0.05) edges.push(e);
    let top = 1;
    const hist = {};
    for (const half of ['left', 'right']) {
      const h = new Array(edges.length - 1).fill(0);
      for (const lg of model.logs[half]) {
        const k = Math.floor((lg - edges[0]) / 0.05);
        if (k >= 0 && k < h.length) h[k]++;
      }
      hist[half] = h;
      top = Math.max(top, ...h);
    }
    const ly0 = Math.log10(0.8), ly1 = Math.log10(top * 1.5);
    const yCount = (v) => hc.y1 - (Math.log10(Math.max(v, 0.8)) - ly0) / (ly1 - ly0) * (hc.y1 - hc.y0);
    ctx.save();
    ctx.beginPath(); ctx.rect(hc.x0, hc.y0 - 2, hc.x1 - hc.x0, hc.y1 - hc.y0 + 2); ctx.clip();
    for (const half of ['left', 'right']) {
      const h = hist[half];
      ctx.beginPath();
      ctx.moveTo(xOf(edges[0]), yCount(0.8));
      for (let k = 0; k < h.length; k++) {
        ctx.lineTo(xOf(edges[k]), yCount(h[k] || 0.8));
        ctx.lineTo(xOf(edges[k + 1]), yCount(h[k] || 0.8));
      }
      ctx.lineTo(xOf(edges[h.length]), yCount(0.8));
      ctx.closePath();
      ctx.fillStyle = hexAlpha(t[half], 0.35);
      ctx.fill();
      ctx.strokeStyle = t[half];
      ctx.lineWidth = 1.2 * pt;
      ctx.stroke();
    }
    ctx.restore();
    for (const m of opts.markers || []) {
      marker(ctx, m.shape, xOf(m.log), yCount(1.4), Math.sqrt(30) * pt, t[m.key], t.bg, 1 * pt);
    }
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 0.8 * pt;
    ctx.beginPath(); ctx.moveTo(hc.x0, hc.y0); ctx.lineTo(hc.x0, hc.y1); ctx.stroke();
    ctx.strokeStyle = t.muted;
    for (const v of [1, 10, 100, 1000, 10000]) {
      if (v > top * 1.5) continue;
      const y = yCount(v);
      ctx.beginPath(); ctx.moveTo(hc.x0, y); ctx.lineTo(hc.x0 - 3.5 * pt, y); ctx.stroke();
      text(ctx, String(v), hc.x0 - 7 * pt, y, { size: 8, scale, color: t.muted, align: 'right', baseline: 'middle' });
    }
    text(ctx, 'queries', hc.x0 - 7 * pt - 22 * pt, (hc.y0 + hc.y1) / 2, { size: 9, scale, color: t.muted, align: 'center', baseline: 'bottom', rotate: -Math.PI / 2 });

    // Stacked bands: the first part of the pipeline is the top band.
    const nP = parts.length, G = model.grid.length;
    const yOf = (v) => ax.y1 - v * (ax.y1 - ax.y0);
    const lo = [], hi = [];
    const cum = new Float64Array(G);
    for (let p = nP - 1; p >= 0; p--) {
      lo[p] = Float64Array.from(cum);
      for (let j = 0; j < G; j++) cum[j] += model.mean[j][p];
      hi[p] = Float64Array.from(cum);
    }
    const runs = [];
    for (let j = 0; j < G; j++) {
      if (!model.ok[j]) continue;
      if (runs.length && runs[runs.length - 1][1] === j - 1) runs[runs.length - 1][1] = j; else runs.push([j, j]);
    }
    for (let p = nP - 1; p >= 0; p--) {
      ctx.fillStyle = colors[p];
      for (const [a, b] of runs) {
        ctx.beginPath();
        for (let j = a; j <= b; j++) { const x = xOf(model.grid[j]); if (j === a) ctx.moveTo(x, yOf(hi[p][j])); else ctx.lineTo(x, yOf(hi[p][j])); }
        for (let j = b; j >= a; j--) ctx.lineTo(xOf(model.grid[j]), yOf(lo[p][j]));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.strokeStyle = t.bg;
    ctx.lineWidth = 0.8 * pt;
    for (let p = 0; p < nP; p++) {
      for (const [a, b] of runs) {
        ctx.beginPath();
        for (let j = a; j <= b; j++) { const x = xOf(model.grid[j]); if (j === a) ctx.moveTo(x, yOf(lo[p][j])); else ctx.lineTo(x, yOf(lo[p][j])); }
        ctx.stroke();
      }
    }
    const decadesPerInch = (lx1 - lx0) / (Lay.MAIN[2] * Lay.W);
    for (let p = 0; p < nP; p++) {
      const halfWidth = (parts[p].label.length * 8.6 * 0.56 / 72 / 2 + 0.08) * decadesPerInch;
      const s = labelSpot(model.grid, lo[p], hi[p], model.ok, halfWidth);
      if (s.spot < 0 || s.room < 0.035) continue;
      text(ctx, parts[p].label, xOf(model.grid[s.spot]), yOf(s.middle), { size: 8.6, scale, color: luminance(colors[p]) > 0.55 ? '#1d1d1f' : '#ffffff', align: 'center', baseline: 'middle' });
    }

    // Axes.
    ctx.strokeStyle = t.grid;
    ctx.lineWidth = 0.8 * pt;
    ctx.beginPath(); ctx.moveTo(ax.x0, ax.y0); ctx.lineTo(ax.x0, ax.y1); ctx.lineTo(ax.x1, ax.y1); ctx.stroke();
    ctx.strokeStyle = t.muted;
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const y = yOf(v);
      ctx.beginPath(); ctx.moveTo(ax.x0, y); ctx.lineTo(ax.x0 - 3.5 * pt, y); ctx.stroke();
      text(ctx, `${Math.round(v * 100)}%`, ax.x0 - 7 * pt, y, { size: 9, scale, color: t.muted, align: 'right', baseline: 'middle' });
    }
    // 1-2-5 ticks where a decade is wide enough for them, else 1-3 or decades only.
    const perDecade = (ax.x1 - ax.x0) / (lx1 - lx0) / pt;
    const steps = perDecade > 140 ? [1, 2, 5] : perDecade > 70 ? [1, 3] : [1];
    const xticks = [];
    for (let e = -1; e <= 4; e++) for (const m of steps) xticks.push(+(m * Math.pow(10, e)).toPrecision(2));
    for (const v of xticks) {
      const lg = Math.log10(v);
      if (lg < lx0 || lg > lx1) continue;
      const x = xOf(lg);
      ctx.beginPath(); ctx.moveTo(x, ax.y1); ctx.lineTo(x, ax.y1 + 3.5 * pt); ctx.stroke();
      text(ctx, `${v} ms`, x, ax.y1 + 7 * pt, { size: 9, scale, color: t.muted, align: 'center', baseline: 'top' });
    }
    text(ctx, opts.xLabel || 'total compile time of the query (log scale)', (ax.x0 + ax.x1) / 2, ax.y1 + 22 * pt, { size: 9, scale, color: t.muted, align: 'center', baseline: 'top' });
    text(ctx, 'mean share of compile time', ax.x0 - 36 * pt, (ax.y0 + ax.y1) / 2, { size: 9, scale, color: t.muted, align: 'center', baseline: 'bottom', rotate: -Math.PI / 2 });

    if (Lay.legend !== false) {
      legend(ctx, parts.map((p, k) => ({ label: p.label, kind: 'patch', color: colors[k] })), (Lay.MAIN[0] + Lay.MAIN[2] + 0.012) * W - 0.9 * 9.2 * scale,
        (1 - Lay.MAIN[1] - Lay.MAIN[3]) * H - 0.9 * 9.2 * scale, scale, t, 9.2, 1.2, 0, false, 0.55);
      legend(ctx, opts.legend || [], (Lay.COUNT[0] + Lay.COUNT[2] + 0.012) * W - 0.9 * 8.6 * scale, (1 - Lay.COUNT[1] - Lay.COUNT[3]) * H - 0.9 * 8.6 * scale,
        scale, t, 8.6, 1.0, 0, false, 0.3);
    }
    return { W, H, ax, xOf, yOf, lo, hi, colors, xlim };
  }

  function partColors(parts, shades) {
    const used = {};
    return parts.map((p) => {
      const list = shades[p.family] || shades.other;
      const k = used[p.family] = (used[p.family] === undefined ? 0 : used[p.family] + 1);
      return list[Math.min(k, list.length - 1)];
    });
  }

  window.ExplorerRender = { THEMES, FAMILY_SHADES, HALF, BINS, D, FONT, kde, quantile, mulberry32, prepareViolins, drawViolins,
    violinLayout, fitLayout, depthOf, subtreeEnd, prepareDominance, drawDominance, fitDominance, partColors, hexAlpha, text, marker,
    legend, wrap };
})();
