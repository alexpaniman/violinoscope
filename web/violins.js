// The violins view. Layers, bottom to top: an SVG with bands, grid and violin shapes; the dots on the GPU; an SVG with
// medians, ticks and the tree of parts; the "when it runs" strips on a canvas; and a canvas for hover and selection,
// so moving the mouse never touches the rest. The figure zooms itself, on a pinch or Ctrl and the wheel: the SVGs
// through their view box, and the canvases drawn again for what shows, at the new scale, so everything stays sharp.
// What-if: each part's factor in a pill at the top of its column, and the factors in a row when it is clicked.
// The tree under the violins is what X.layout shows: a triangle opens or closes a column, a + at the end of a
// column's children adds the ones not shown, Shift and a click on names picks violins to merge, a name dragged onto
// another column merges the two, and a double-click on a name renames it.
(function () {
  'use strict';
  const X = window.TX, S = X.S, R = X.R, data = X.data;
  const { $, esc, clamp, n1, txt } = X;
  const HALF = R.HALF, RIGHT = 20, AX = 80, MIN_COL = 26, MAX_COL = 68, ANGLE = 30 * Math.PI / 180, SIZE = 12.5, DOT = 2.8, DIAMOND = 10;
  const DOT_R = DOT / 2;  // as the GPU draws it

  const MAX_ZOOM = 12;

  let root, pill, pills, menu, under, over, heat, hover, pad, points;
  let G = null, lastKey = null;
  // The zoom: a layer point p shows at (x, y) + z·p. Marks grow only as its square root, so zooming in pulls crowded
  // dots apart, and lines keep their width.
  const Z = { z: 1, x: 0, y: 0 };
  const mark = () => 1 / Math.sqrt(Z.z);
  const view = (W, H) => Object.assign(X.layerView(root, W, H, Z), { mark: mark() });
  const toLayer = (px, py) => [(px - Z.x) / Z.z, (py - Z.y) / Z.z];

  function init() {
    root = $('violins'); pill = $('v-whatif'); pills = $('v-factors'); menu = $('v-factor-menu');
    // The box takes any factor from 0 to 100, typed as 0.3, ×0.3 or x0.3, on Enter; the arrows step as − and + do.
    menu.addEventListener('keydown', (e) => {
      if (e.target.tagName !== 'INPUT') return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { stepFactor(e.key === 'ArrowUp' ? 1 : -1); e.preventDefault(); return; }
      if (e.key !== 'Enter') return;
      const v = Number(e.target.value.trim().replace(/^[x×*]\s*/i, '').replace(',', '.'));
      if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= 100) X.setFactor(menuId, v);
      else { e.target.classList.add('bad'); setTimeout(() => e.target.classList.remove('bad'), 700); }
      e.target.select();
      e.preventDefault();
    });
    under = $('v-under'); over = $('v-over'); heat = $('v-heat'); hover = $('v-hover'); pad = $('hitpad');
    points = X.Points($('v-dots'));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Layout and drawing.

  function render(opts) {
    const W = root.clientWidth, H = root.clientHeight, T = X.T;
    if (!W || !H) return;
    const TOP = X.contentTop() + 8;
    clampZoom(W, H, TOP);
    if (!X.layout.ready) { loading(W, H, TOP); return; }
    const p = X.prepare(S.mode, S.linear);
    const key = `${p.key}|${W}x${H}|${T.scheme}|${TOP}|${[...X.picked].join(',')}`;
    if (key === lastKey && !(opts && opts.force)) { drawHover(); return; }
    const glide = !!(G && G.p.cols.length === p.cols.length && G.p.vk === p.vk && G.p.cols.every((c, i) => c.id === p.cols[i].id));
    lastKey = key;

    // Columns keep their width until there are more than fit, so opening one moves only the columns after it and no
    // violin changes shape; the plot ends after the last column.
    const n = p.cols.length, colW = clamp((W - AX - RIGHT) / Math.max(n, 16), MIN_COL, MAX_COL), END = AX + n * colW;
    const xOf = (c) => AX + (c + 0.5) * colW;
    // The unit's own span is the root the columns branch from; in Share it is 100% everywhere, so it shows only its
    // median time.
    const depth = p.cols.map((col) => (col.root ? 0 : X.depthIdx[col.base] + 1));
    const isParent = p.cols.map((col) => X.layout.kids(col.id).length > 0);
    const bare = (c) => p.cols[c].root && S.mode === 'share';
    const visKids = p.cols.map((col) => p.cols.map((_, j) => j).filter((j) => p.cols[j].parent === col.id));
    // A name is bold while what it holds is shown under it.
    const weight = p.cols.map((col, c) => (col.root || visKids[c].length ? 600 : 400));
    // A column with children not shown has a + at the end of those it shows.
    const more = p.cols.map((col, c) => visKids[c].length > 0 && X.layout.hidden(col.id) > 0);
    const maxD = Math.max(0, ...depth);

    // Slanted labels all start on one line below the tree, so neighbours never cross; above it, room for the × that
    // hides a violin, clear of the last row of triangles. A deeper tree packs its levels closer and takes more room, so
    // the names below it keep theirs.
    const ROW = maxD > 3 ? 12 : 15, NODE0 = 8, labelY = NODE0 + maxD * ROW + 26;
    const cap = clamp(H * 0.19, 90, 180) + Math.max(0, maxD - 2) * ROW;
    const labels = p.cols.map((col, c) => X.fitText(col.label, SIZE, weight[c], (cap - labelY - 8) / Math.sin(ANGLE)));
    const lens = labels.map((s, c) => X.textWidth(s, SIZE, weight[c]));
    const treeH = labelY + Math.max(...lens) * Math.sin(ANGLE) + SIZE * Math.cos(ANGLE) + 8;

    const MED = 32, HEAD = 18, BOTTOM = 14;
    const rest = Math.max(200, H - TOP - MED - treeH - HEAD - BOTTOM);
    const tlH = clamp(rest * 0.25, 64, 180), vH = rest - tlH;
    const V = { y0: TOP, y1: TOP + vH }, MD = { y0: V.y1, y1: V.y1 + MED };
    const TR = { y0: MD.y1, y1: MD.y1 + treeH }, TL = { y0: TR.y1 + HEAD, y1: TR.y1 + HEAD + tlH };
    const sc = p.scale, yOfU = (u) => V.y1 - (u - sc.lo) / (sc.hi - sc.lo) * (V.y1 - V.y0);
    const nodeY = (d) => TR.y0 + NODE0 + d * ROW;
    const half = HALF * colW;

    // Under: bands, grid, violins.
    const u = [];
    const ends = R.subtreeEnd(p.cols);
    let band = 0;
    p.cols.forEach((col, c) => {
      if (col.root || depth[c] !== 1) return;
      if (band++ % 2 === 0) u.push(`<rect x="${n1(xOf(c) - colW / 2)}" y="${n1(V.y0 - 8)}" width="${n1((ends[c] - c + 1) * colW)}" height="${n1(TR.y0 + labelY - V.y0 + 8)}" rx="6" fill="${T.band}"/>`);
    });
    for (const t of sc.ticks) {
      const y = yOfU(sc.fwd(t.v));
      if (t.v !== 0 && y >= V.y0 - 1 && y <= V.y1 + 1) u.push(`<path d="M${AX} ${n1(y)}H${n1(END)}" stroke="${T.grid}"/>`);
    }
    // A half's outline, and its area: the area closes along the middle, where the halves meet by colour alone.
    const outline = (c, h) => {
      const g = h.density;
      let d = '';
      for (let i = 0; i < g.grid.length; i++) d += `${i ? 'L' : 'M'}${n1(xOf(c) + h.side * g.dens[i] * half)} ${n1(yOfU(g.grid[i]))}`;
      return d;
    };
    const area = (c, h) => {
      const g = h.density;
      return `M${n1(xOf(c))} ${n1(yOfU(g.grid[0]))}${outline(c, h).replace('M', 'L')}L${n1(xOf(c))} ${n1(yOfU(g.grid[g.grid.length - 1]))}Z`;
    };
    u.push(`<defs><clipPath id="vclip"><rect x="${AX}" y="${n1(V.y0 - 6)}" width="${n1(END - AX)}" height="${n1(vH + 6)}"/></clipPath></defs><g clip-path="url(#vclip)">`);
    for (let c = 0; c < n; c++) {
      for (const hk of ['left', 'right']) {
        const h = p.model.cols[c].halves[hk];
        if (h.density) u.push(`<path d="${area(c, h)}" fill="${T[hk]}" fill-opacity="0.12"/><path d="${outline(c, h)}" fill="none" stroke="${T[hk]}" stroke-opacity="0.7" stroke-width="1" stroke-linejoin="round"/>`);
      }
      if (p.ghost) {
        for (const hk of ['left', 'right']) {
          const h = p.ghost.cols[c].halves[hk];
          if (h.density) u.push(`<path d="${outline(c, h)}" fill="none" stroke="${T.ink}" stroke-opacity="0.45" stroke-dasharray="3 3"/>`);
        }
      }
    }
    u.push('</g>');

    // Dots: every compilation the same size; single-query groups as rings. A dot stays inside its half: off the
    // middle line, its edge at most on the outline. Where the violin is thinner than a dot, the dot sits in the
    // middle of what there is.
    const offset = (wi, qi) => {
      const room = wi * half;
      return room > 2 * DOT_R ? DOT_R + qi * (room - 2 * DOT_R) : room / 2;
    };
    // A half's dots are spread to fill its violin evenly, so its outline carries the density and the dots a texture.
    // Their opacity is set so that, overlaps included, they cover about half of the violin: many dots each faint,
    // a few each strong.
    const alphaOf = (h) => {
      const g = h.density;
      if (!g) return 0.9;
      let area = 0;
      for (let i = 0; i + 1 < g.grid.length; i++) area += (g.dens[i] + g.dens[i + 1]) / 2 * half * Math.abs(yOfU(g.grid[i + 1]) - yOfU(g.grid[i]));
      const cover = h.units.length * Math.PI * DOT_R * DOT_R / Math.max(1, area);
      return clamp(0.7 / Math.max(cover, 1e-9), 0.02, 0.9);
    };
    const N = p.cols.reduce((a, _, c) => a + p.model.cols[c].halves.left.units.length + p.model.cols[c].halves.right.units.length
      + p.model.cols[c].markers.reduce((m, mk) => m + mk.v.length, 0), 0);
    const pos = new Float32Array(2 * N), rgba = new Uint8Array(4 * N), size = new Float32Array(N);
    const pts = [], where = [];
    const rgbOf = { left: X.rgb(T.left), right: X.rgb(T.right), m0: X.rgb(T.m0), m1: X.rgb(T.m1), m2: X.rgb(T.m2), m3: X.rgb(T.m3) };
    let k = 0;
    for (let c = 0; c < n; c++) {
      const cap = p.model.cols[c].halves.left.units.length + p.model.cols[c].halves.right.units.length + p.model.cols[c].markers.reduce((a, mk) => a + mk.v.length, 0);
      const px = new Float32Array(cap), py = new Float32Array(cap), pu = new Int32Array(cap);
      let m = 0;
      const at = new Int32Array(X.NU).fill(-1);
      for (const hk of ['left', 'right']) {
        const h = p.model.cols[c].halves[hk], rgb = rgbOf[hk], alpha = alphaOf(h);
        for (let i = 0; i < h.units.length; i++) {
          const ok = Number.isFinite(h.u[i]) && !bare(c);
          const x = xOf(c) + h.side * offset(h.w[i], h.q[i]), y = ok ? yOfU(clamp(h.u[i], sc.lo, sc.hi)) : V.y1;
          pos[2 * k] = x; pos[2 * k + 1] = y;
          rgba[4 * k] = rgb[0]; rgba[4 * k + 1] = rgb[1]; rgba[4 * k + 2] = rgb[2]; rgba[4 * k + 3] = ok ? Math.round(alpha * 255) : 0;
          size[k] = DOT;
          k++;
          if (ok) { at[h.units[i]] = m; px[m] = x; py[m] = y; pu[m] = h.units[i]; m++; }
        }
      }
      for (const { m: mk, v } of p.model.cols[c].markers) {
        v.forEach((value, j) => {
          const uu = sc.fwd(value), ok = Number.isFinite(uu) && !bare(c), rgb = rgbOf[mk.key] || rgbOf.m3;
          const x = xOf(c), y = ok ? yOfU(clamp(uu, sc.lo, sc.hi)) : V.y1;
          pos[2 * k] = x; pos[2 * k + 1] = y;
          rgba[4 * k] = rgb[0]; rgba[4 * k + 1] = rgb[1]; rgba[4 * k + 2] = rgb[2]; rgba[4 * k + 3] = ok ? 255 : 0;
          size[k] = -DIAMOND;
          k++;
          if (ok) { at[mk.units[j]] = m; px[m] = x; py[m] = y; pu[m] = mk.units[j]; m++; }
        });
      }
      pts.push({ x: px.subarray(0, m), y: py.subarray(0, m), unit: pu.subarray(0, m) });
      where.push(at);
    }

    // Over: axis, medians, the tree and its labels.
    const o = [];
    for (const t of sc.ticks) {
      const y = yOfU(sc.fwd(t.v));
      if (y >= V.y0 - 1 && y <= V.y1 + 1) o.push(txt(AX - 10, y, t.label, { anchor: 'end', base: 'central', fill: T.muted, tabular: true }));
    }
    if (sc.above) o.push(txt(6, V.y0 + 4, `↑ ${X.fmtInt(sc.above)} more`, { base: 'central', fill: T.muted, size: 10.5 }));
    // What the axis measures, along it.
    o.push(`<text transform="translate(16 ${n1((V.y0 + V.y1) / 2)}) rotate(-90)" text-anchor="middle" dominant-baseline="central" font-family="${X.SANS}" font-size="11.5" font-weight="500" fill="${T.muted}">`
      + `${esc(S.mode === 'share' ? `Share of ${X.UNIT} time` : `Time per ${X.UNIT}`)}</text>`);
    o.push(`<path d="M${AX} ${n1(V.y1)}H${n1(END)}" stroke="${T.line}"/>`);
    let med = '';
    for (let c = 0; c < n; c++) {
      for (const hk of ['left', 'right']) {
        const h = p.model.cols[c].halves[hk];
        if (!Number.isFinite(h.median) || bare(c)) continue;
        const y = clamp(yOfU(sc.fwd(h.median)), V.y0, V.y1);
        med += `M${n1(xOf(c))} ${n1(y)}H${n1(xOf(c) + h.side * half * 0.92)}`;
      }
    }
    o.push(`<path d="${med}" stroke="${T.ink}" stroke-width="1.8" stroke-linecap="round"/>`);
    o.push(txt(AX - 10, MD.y0 + 13, 'median', { anchor: 'end', base: 'central', fill: T.muted, size: 11 }));
    for (let c = 0; c < n; c++) {
      ['left', 'right'].forEach((hk, j) => {
        const h = p.model.cols[c].halves[hk];
        if (!Number.isFinite(h.median)) return;
        const label = bare(c) ? X.fmtMs(X.median(h.units.map((i) => X.totalMs(i, false))))
          : S.mode === 'share' ? X.fmtPct(h.median) : X.M.msLabel(h.median);
        o.push(txt(xOf(c), MD.y0 + 12 + j * 14, label, { anchor: 'middle', base: 'central', fill: T[hk], size: 11.5, weight: 500, tabular: true }));
      });
    }
    let lines = '';
    // The + comes after everything under the column, where what it adds usually goes.
    const plusX = (c) => xOf(ends[c]) + colW / 2;
    p.cols.forEach((col, c) => {
      const y = nodeY(depth[c]), ch = visKids[c];
      if (ch.length) {
        const last = ch[ch.length - 1];
        // Past the last child, to the + when there is one.
        lines += `M${n1(xOf(c) + 7)} ${n1(y)}H${n1(more[c] ? plusX(c) - 7 : xOf(last) - 4)}`;
        if (!more[c]) lines += `Q${n1(xOf(last))} ${n1(y)} ${n1(xOf(last))} ${n1(y + 4)}`;
        for (const j of ch) lines += `M${n1(xOf(j))} ${n1(j === last && !more[c] ? y + 4 : y)}V${n1(nodeY(depth[j]) - (isParent[j] ? 6 : 0))}`;
      }
      lines += `M${n1(xOf(c))} ${n1(y + (isParent[c] ? 5 : 0))}V${n1(TR.y0 + labelY - 2)}`;
    });
    o.push(`<path d="${lines}" fill="none" stroke="${T.line}"/>`);
    const deg = n1(-ANGLE * 180 / Math.PI);
    p.cols.forEach((col, c) => {
      const x = xOf(c), y = nodeY(depth[c]), picked = X.picked.has(col.id);
      if (col.root) o.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="3.5" fill="${T.muted}"/>`);
      else if (isParent[c]) {
        const open = visKids[c].length > 0;
        const tri = open ? `M${n1(x - 4.5)} ${n1(y - 2.5)}L${n1(x + 4.5)} ${n1(y - 2.5)}L${n1(x)} ${n1(y + 3)}Z`
          : `M${n1(x - 2.5)} ${n1(y - 4.5)}L${n1(x + 3)} ${n1(y)}L${n1(x - 2.5)} ${n1(y + 4.5)}Z`;
        o.push(`<g class="hit" data-open="${esc(col.id)}"><title>${open ? 'Close' : 'Open'} ${esc(col.label)}</title><rect x="${n1(x - 11)}" y="${n1(y - 8)}" width="22" height="16" fill="transparent"/><path d="${tri}" fill="${open ? T.muted : T.ink}"/></g>`);
      } else o.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="2" fill="${T.line}"/>`);
      if (more[c]) {
        const px = plusX(c);
        o.push(`<g class="hit add" data-add="${esc(col.id)}"><title>Add what ${esc(col.label)} has that is not shown (${X.layout.hidden(col.id)})</title>`
          + `<circle cx="${n1(px)}" cy="${n1(y)}" r="6.5" fill="${T.surface}" stroke="${T.line}"/>`
          + `<path d="M${n1(px - 3)} ${n1(y)}h6M${n1(px)} ${n1(y - 3)}v6" stroke="${T.muted}" stroke-width="1.4" stroke-linecap="round"/></g>`);
      }
      // A merged violin's name in italics; picked to merge, on a tint.
      o.push(`<g class="hit" data-col="${c}" transform="translate(${n1(x + 3)} ${n1(TR.y0 + labelY)}) rotate(${deg})">`
        + `<rect x="${n1(-lens[c] - 4)}" y="-3" width="${n1(lens[c] + 8)}" height="${n1(SIZE + 6)}" rx="4" fill="${picked ? T.sel : 'transparent'}" fill-opacity="${picked ? 0.22 : 0}"${picked ? ` stroke="${T.sel}"` : ''}/>`
        + `<text text-anchor="end" dominant-baseline="hanging" font-family="${X.SANS}" font-size="${SIZE}" font-weight="${weight[c]}"${col.merged ? ' font-style="italic"' : ''} fill="${T.ink}">${esc(labels[c])}</text></g>`);
    });
    // Its axis as the violins' is: named along it, ticked where its grid lines are, through each compilation's time.
    o.push(`<text transform="translate(16 ${n1((TL.y0 + TL.y1) / 2)}) rotate(-90)" text-anchor="middle" dominant-baseline="central" font-family="${X.SANS}" font-size="11.5" font-weight="500" fill="${T.muted}">When it runs</text>`);
    [['start', 0], ['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['end', 1]].forEach(([label, v]) => {
      o.push(txt(AX - 10, clamp(TL.y0 + v * (TL.y1 - TL.y0), TL.y0 + 6, TL.y1 - 6), label, { anchor: 'end', base: 'central', fill: T.muted, tabular: true }));
    });

    under.innerHTML = u.join('');
    over.innerHTML = o.join('');
    if (glide) for (const el of [under, over]) { el.classList.remove('fade'); void el.getBoundingClientRect(); el.classList.add('fade'); }
    points.resize(W, H, view(W, H));
    points.set(pos, rgba, size, { x: AX, y: V.y0 - 6, w: END - AX, h: vH + 12 }, glide);
    G = { W, H, n, colW, xOf, V, TR, TL, MD, yOfU, p, pts, where, half, labelY, lens, END, deg, pad: { x: AX, y: V.y0 - 6, w: END - AX, h: vH + 12 } };
    placeLayers();
    drawHeat();
    drawHover();
  }

  // Until every span is read, how far that has got.
  function loading(W, H, top) {
    const T = X.T, [k, n] = X.layout.progress();
    under.innerHTML = '';
    over.removeAttribute('viewBox');
    over.innerHTML = txt(W / 2, Math.max(top + 120, H * 0.4), `Reading spans: ${k} of ${n} files`, { anchor: 'middle', base: 'central', fill: T.muted, size: 13 });
    points.resize(W, H, view(W, H));
    points.set(new Float32Array(0), new Uint8Array(0), new Float32Array(0), { x: 0, y: 0, w: W, h: H }, false);
    for (const c of [heat, hover]) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    G = null;
    lastKey = null;
  }

  // The old look: per column, how many compilations are in the part at each moment, darker for more.
  function drawHeat() {
    const { W, H, n, xOf, half, TL, p, END, colW } = G, T = X.T;
    const ctx = heat.getContext('2d');
    // The whole compilation runs from start to end: no strip of its own.
    const from = p.cols[0] && p.cols[0].root ? xOf(0) + colW / 2 : AX;
    ctx.setTransform(...X.toView(X.fitCanvas(heat, W, H, view(W, H))));
    ctx.clearRect(0, 0, W, H);
    const h = TL.y1 - TL.y0, B = R.BINS;
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of [0.25, 0.5, 0.75]) { ctx.moveTo(from, Math.round(TL.y0 + v * h) + 0.5); ctx.lineTo(END, Math.round(TL.y0 + v * h) + 0.5); }
    ctx.stroke();
    for (let c = 0; c < n; c++) {
      if (p.cols[c].root) continue;
      const occ = p.model.cols[c].occupancy;
      for (const [hk, x0] of [['left', xOf(c) - half], ['right', xOf(c)]]) {
        const o = occ && occ[hk];
        if (!o) continue;
        ctx.fillStyle = T[hk];
        for (let b = 0; b < B; b++) {
          if (o[b] <= 0) continue;
          ctx.globalAlpha = Math.pow(Math.min(1, o[b]), 0.6) * 0.95;
          ctx.fillRect(x0, TL.y0 + b / B * h, half, h / B + 0.4);
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = T.grid;
      ctx.strokeRect(Math.round(xOf(c) - half) + 0.5, Math.round(TL.y0) + 0.5, Math.round(2 * half), Math.round(h));
    }
  }

  // Hover, selection, search matches and the open part's column.
  function drawHover() {
    if (!G) return;
    const { W, H } = G, T = X.T;
    // On the CPU: on a GPU canvas a frame that only clears was sometimes dropped, leaving the last hover on screen.
    const ctx = hover.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(...X.toView(X.fitCanvas(hover, W, H, view(W, H))));
    ctx.clearRect(0, 0, W, H);
    const tint = (c, a) => {
      ctx.globalAlpha = a;
      ctx.fillStyle = T.ink;
      ctx.beginPath();
      ctx.roundRect(G.xOf(c) - G.colW / 2, G.V.y0 - 8, G.colW, G.TR.y0 + G.labelY - G.V.y0 + 8, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    if (S.card) { const c = G.p.cols.findIndex((col) => col.id === S.card); if (c >= 0) tint(c, 0.06); }
    if (lift && lift.moved) { tint(lift.c, 0.05); if (lift.to !== null) tint(lift.to, 0.14); }
    if (lit) {
      const c = G.p.cols.findIndex((col) => col.id === lit.id);
      if (c >= 0) tint(c, 0.18 * Math.max(0, 1 - (performance.now() - lit.t) / 900));
    }
    if (S.hoverCol !== null && S.hoverCol < G.n) tint(S.hoverCol, 0.04);
    if (S.matches && S.matches.size) {
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = T.bg;
      ctx.fillRect(AX, G.V.y0 - 6, W - AX - RIGHT, G.V.y1 - G.V.y0 + 6);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 1.6 * mark();
      ctx.beginPath();
      const r = 3.5 * mark();
      G.pts.forEach((pp) => { for (let k = 0; k < pp.unit.length; k++) if (S.matches.has(pp.unit[k])) { ctx.moveTo(pp.x[k] + r, pp.y[k]); ctx.arc(pp.x[k], pp.y[k], r, 0, Math.PI * 2); } });
      ctx.stroke();
    }
    for (const [unit, strong] of [[S.sel, true], [S.hover, false]]) {
      if (unit === null || (strong === false && unit === S.sel)) continue;
      // Its dot in each column, marked; nothing joins them.
      const at = [];
      G.where.forEach((w, c) => { if (w[unit] >= 0) at.push([G.pts[c].x[w[unit]], G.pts[c].y[w[unit]]]); });
      if (!at.length) continue;
      const color = T[X.sideKey(data.units[unit].g)] || T.ink;
      const m = mark();
      for (const [x, y] of at) {
        ctx.beginPath(); ctx.arc(x, y, 4.6 * m, 0, Math.PI * 2); ctx.fillStyle = T.bg; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 3.2 * m, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        // A ring makes it easy to find in each violin: thicker for the selected compilation.
        ctx.beginPath(); ctx.arc(x, y, (strong ? 6.2 : 5.6) * m, 0, Math.PI * 2); ctx.strokeStyle = T.ink; ctx.lineWidth = (strong ? 1.6 : 1) * m; ctx.stroke();
      }
      // Its own time in each column's strip.
      const u = data.units[unit], h = G.TL.y1 - G.TL.y0;
      ctx.fillStyle = T.ink;
      ctx.globalAlpha = strong ? 0.75 : 0.85;
      G.p.cols.forEach((col, c) => {
        if (col.root) return;
        const f = u.f[col.base], hw = G.half * 0.5;
        let pos = 0;
        for (let j = 0; j < f.length; j += 2) {
          const a = pos + f[j], b = a + f[j + 1];
          pos = b;
          ctx.fillRect(G.xOf(c) - hw, G.TL.y0 + a / X.GRID * h, 2 * hw, Math.max(1, (b - a) / X.GRID * h));
        }
      });
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Pointer.

  // In layer coordinates; within 7 px on screen, or a dot's own size when zoomed in close.
  function nearestDot(px, py) {
    if (!G || py < G.V.y0 - 6 || py > G.V.y1 + 6) return null;
    const c = Math.floor((px - AX) / G.colW);
    if (c < 0 || c >= G.n) return null;
    const pp = G.pts[c];
    let best = null, bd = Math.max((DOT_R + 1) * mark(), 7 / Z.z) ** 2;
    for (let k = 0; k < pp.unit.length; k++) {
      const dx = pp.x[k] - px, dy = pp.y[k] - py, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = { unit: pp.unit[k], c }; }
    }
    return best;
  }

  // Two lines: the compilation, its group and compile time; the part, with what the axis shows first.
  function dotTip(hit) {
    const u = data.units[hit.unit], col = G.p.cols[hit.c], side = X.sideKey(u.g), T = X.T;
    const ms = X.colMs(hit.unit, col, false), total = X.totalMs(hit.unit, false), share = X.fmtPct(ms / total);
    const [main, aside] = S.mode === 'share' ? [share, X.fmtMs(ms)] : [X.fmtMs(ms), share];
    return `<div class="tt">${X.glyph(side === 'left' || side === 'right' ? side : 'marker', T[side])}<b>${X.esc(u.l)}</b>`
      + `<span>${X.esc(X.groupName(u.g))} · ${X.fmtMs(total)}${X.proj() ? `, measured ${X.fmtMs(u.ms)}` : ''}</span></div>`
      + `<div class="tt"><span class="part">${X.esc(col.label)}</span><b>${main}</b><span>${aside}</span></div>`;
  }

  // The column at a point of the layer, by where it is across: along the violins and the tree, and in the strips.
  function colAt(lx, ly) {
    if (!G || lx < AX || lx >= G.END) return null;
    const along = (ly >= G.V.y0 - 6 && ly <= G.TR.y0 + G.labelY) || (ly >= G.TL.y0 && ly <= G.TL.y1);
    return along ? Math.min(G.n - 1, Math.floor((lx - AX) / G.colW)) : null;
  }
  // Where a column's line meets its name, on the stage.
  const tipOf = (c) => ({ x: Z.x + G.xOf(c) * Z.z, y: Z.y + (G.TR.y0 + G.labelY - 2) * Z.z });

  // px, py: on the stage; the figure's own coordinates come from the zoom.
  function move(e, px, py) {
    if (drag) { pan(px, py); return; }
    if (!G) return;
    if (lift) { carry(e, px, py); return; }
    // Over a pill or the factors, nothing under them is hovered.
    if (e.target.closest && e.target.closest('[data-pill], #v-factor-menu')) {
      if (S.hover !== null) { S.hover = null; X.schedule(drawHover); }
      pad.classList.remove('on-dot');
      X.hideTip();
      return;
    }
    const [lx, ly] = toLayer(px, py);
    const colEl = e.target.closest && e.target.closest('[data-col]');
    const col = colEl ? Number(colEl.dataset.col) : null;
    let dirty = false;
    if (col !== S.hoverCol) { S.hoverCol = col; dirty = true; }
    let hit = null;
    if (col === null && !(e.target.closest && e.target.closest('[data-open], [data-add]'))) hit = nearestDot(lx, ly);
    const unit = hit ? hit.unit : null;
    if (unit !== S.hover) { S.hover = unit; dirty = true; }
    pad.classList.toggle('on-dot', !!hit);
    if (hit) X.tipHtml(dotTip(hit), px, py); else X.hideTip();
    showPill(col !== null ? col : lx >= AX && lx < G.END && ly >= G.V.y0 - 6 && ly <= G.V.y1 + 6 ? Math.floor((lx - AX) / G.colW) : null);
    const along = col !== null ? col : colAt(lx, ly);
    X.edit.showHide(along !== null && !G.p.cols[along].root ? Object.assign({ id: G.p.cols[along].id, label: G.p.cols[along].label }, tipOf(along)) : null);
    if (dirty) X.schedule(drawHover);
  }
  function leave(e) {
    // Off the stage, a carried name is dropped nowhere; over the controls, it is still carried.
    if (lift) { if (!e) letGo(); return; }
    if (S.hover !== null || S.hoverCol !== null) { S.hover = null; S.hoverCol = null; X.schedule(drawHover); }
    X.hideTip();
    showPill(null);
    if (!(e && e.target && e.target.closest && e.target.closest('#v-hide'))) X.edit.showHide(null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // What-if. A part's factor shows in a pill at the top of its column: always once it is changed, and under the
  // pointer while it is ×1. A click puts the factors in a row there, which stays put until a click elsewhere or Esc.

  let menuId = null;
  const factorOf = (id) => (S.factors.has(id) ? S.factors.get(id) : 1);
  const pillX = (c) => Z.x + G.xOf(c) * Z.z;
  const pillTop = () => Math.max(Z.y + (G.V.y0 - 4) * Z.z, X.contentTop() - 4);
  const pillTitle = (col) => `What if ${col.label} took longer or shorter`;

  function showPill(c) {
    const col = c === null || !G ? null : G.p.cols[c];
    if (!col || col.root || drag || menuId !== null || factorOf(col.id) !== 1) { pill.hidden = true; return; }
    if (!pill.hidden && pill.dataset.pill === String(c)) return;
    pill.dataset.pill = String(c);
    pill.title = pillTitle(col);
    pill.hidden = false;
    pill.style.left = `${Math.round(pillX(c))}px`;
    pill.style.top = `${Math.round(pillTop())}px`;
  }
  function placePills() {
    if (!G) return;
    const top = Math.round(pillTop());
    let html = '';
    G.p.cols.forEach((col, c) => {
      const f = col.root ? 1 : factorOf(col.id);
      if (f === 1 || col.id === menuId) return;
      html += `<button type="button" class="whatif-pill set" data-pill="${c}" title="${esc(pillTitle(col))}" style="left:${Math.round(pillX(c))}px;top:${top}px">${X.fmtFactor(f)}</button>`;
    });
    if (pills.innerHTML !== html) pills.innerHTML = html;
    if (menuId !== null) placeMenu();
  }
  function placeMenu() {
    const c = G.p.cols.findIndex((col) => col.id === menuId);
    if (c < 0) { closeMenu(); return; }
    const f = factorOf(menuId);
    if (menu.dataset.part !== menuId) {
      menu.dataset.part = menuId;
      menu.setAttribute('aria-label', `What if ${G.p.cols[c].label} took this many times its time`);
      menu.innerHTML = '<button type="button" data-step="-1" aria-label="Less" title="Less (↓)">−</button>'
        + '<label class="custom" title="Any factor from 0 to 100: type it and press Enter">×<input inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Factor"></label>'
        + '<button type="button" data-step="1" aria-label="More" title="More (↑)">+</button>';
    }
    const input = menu.querySelector('input');
    if (document.activeElement !== input || input.value === '') input.value = String(X.round3(f));
    else if (Number(input.value.replace(/^[x×*]\s*/i, '')) !== f) { input.value = String(X.round3(f)); input.select(); }
    menu.classList.toggle('set', f !== 1);
    menu.hidden = false;
    const w = menu.offsetWidth;
    menu.style.left = `${Math.round(clamp(pillX(c) - w / 2, 8, G.W - w - 8))}px`;
    menu.style.top = `${Math.round(pillTop() - 4)}px`;
  }
  function openMenu(c) {
    menuId = G.p.cols[c].id;
    pill.hidden = true;
    placePills();
    const input = menu.querySelector('input');
    input.focus({ preventScroll: true });
    input.select();
  }
  // − and + step through the usual factors; past ×3 each step is half as much again.
  function stepFactor(dir) {
    const f = factorOf(menuId), eps = 1e-9;
    const next = dir < 0 ? [...X.STOPS].reverse().find((s) => s < f - eps) : X.STOPS.find((s) => s > f + eps);
    X.setFactor(menuId, next !== undefined ? next : dir < 0 ? 0 : Math.min(100, X.round3(f * 1.5)));
  }
  function closeMenu() {
    if (menuId === null) return false;
    menuId = null;
    menu.hidden = true;
    delete menu.dataset.part;
    placePills();
    return true;
  }

  let cardSoon = 0;
  function click(e, px, py) {
    if (dragged) { dragged = false; return; }
    const pillEl = e.target.closest && e.target.closest('[data-pill]');
    if (pillEl) { openMenu(Number(pillEl.dataset.pill)); return; }
    const step = e.target.closest && e.target.closest('[data-step]');
    if (step) { stepFactor(Number(step.dataset.step)); return; }
    if (e.target.closest && e.target.closest('#v-factor-menu')) return;
    const open = e.target.closest && e.target.closest('[data-open]');
    if (open) {
      const id = open.dataset.open;
      if (X.layout.open(id)) X.layout.collapse(id); else X.layout.expand(id);
      return;
    }
    const add = e.target.closest && e.target.closest('[data-add]');
    if (add) { X.edit.openAdd(add.dataset.add, add.getBoundingClientRect()); return; }
    const colEl = e.target.closest && e.target.closest('[data-col]');
    if (colEl) {
      const col = G.p.cols[Number(colEl.dataset.col)];
      // Shift and a click picks it to merge with others; a click alone opens its card.
      if (e.shiftKey && !col.root) { X.edit.pick(col.id); return; }
      // A moment later, so that a double-click renames it instead.
      clearTimeout(cardSoon);
      if (e.detail > 1) return;
      const rect = colEl.getBoundingClientRect();
      cardSoon = setTimeout(() => X.openCard(col.id, rect), 220);
      return;
    }
    const [lx, ly] = toLayer(px, py);
    const hit = nearestDot(lx, ly);
    if (hit) X.select(hit.unit);
    else if (ly >= G.V.y0 - 6 && ly <= G.V.y1 + 6 && S.sel !== null) X.select(null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Zoom.

  // Never smaller than the view, and never past the figure's edges or above where it starts.
  function clampZoom(W, H, top) {
    Z.z = clamp(Z.z, 1, MAX_ZOOM);
    Z.x = clamp(Z.x, W * (1 - Z.z), 0);
    Z.y = clamp(Z.y, H * (1 - Z.z), top * (1 - Z.z));
    // Zoomed in, the figure stays below the controls.
    root.style.clipPath = Z.z > 1 ? `inset(${Math.max(0, top - 8)}px 0 0 0)` : '';
    root.classList.toggle('zoomed', Z.z > 1);
  }
  // The SVGs show the part of the figure in view; the pad that takes the pointer covers the plot where it shows.
  function placeLayers() {
    const { W, H, pad: P } = G;
    for (const el of [under, over]) el.setAttribute('viewBox', [-Z.x / Z.z, -Z.y / Z.z, W / Z.z, H / Z.z].map((v) => v.toFixed(3)).join(' '));
    pad.style.transform = `translate(${Math.round(Z.x + P.x * Z.z)}px, ${Math.round(Z.y + P.y * Z.z)}px)`;
    pad.style.width = `${Math.round(P.w * Z.z)}px`;
    pad.style.height = `${Math.round(P.h * Z.z)}px`;
    placePills();
  }
  let frame = 0;
  function zoomed() {
    if (!G) return;
    clampZoom(G.W, G.H, X.contentTop());
    placeLayers();
    X.hideTip();
    pill.hidden = true;
    closeMenu();
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; rezoom(); });
  }
  function zoomAt(px, py, f) {
    const z = clamp(Z.z * f, 1, MAX_ZOOM), k = z / Z.z;
    Z.x = px - (px - Z.x) * k; Z.y = py - (py - Z.y) * k; Z.z = z;
    zoomed();
  }
  // Ctrl and the wheel, or a pinch, zoom about the pointer; zoomed in, the wheel pans. True when it was used.
  function wheel(e, px, py) {
    if (!G) return false;
    if (e.ctrlKey || e.metaKey) { zoomAt(px, py, Math.exp(-clamp(e.deltaY, -50, 50) * 0.01)); return true; }
    if (Z.z === 1) return false;
    Z.x -= e.shiftKey ? e.deltaY : e.deltaX;
    Z.y -= e.shiftKey ? 0 : e.deltaY;
    zoomed();
    return true;
  }
  // Zoomed in, dragging pans; a drag is not a click.
  let drag = null, dragged = false;
  function down(e, px, py) {
    dragged = false;
    const name = e.target.closest && e.target.closest('[data-col]');
    if (name && G && !e.shiftKey && !G.p.cols[Number(name.dataset.col)].root) { lift = { c: Number(name.dataset.col), px, py, moved: false, to: null }; return false; }
    if (Z.z === 1 || (e.target.closest && e.target.closest('.hit, [data-pill], #v-factor-menu'))) return false;
    drag = { px, py, x: Z.x, y: Z.y, moved: false };
    return true;
  }
  function pan(px, py) {
    const dx = px - drag.px, dy = py - drag.py;
    if (!drag.moved && dx * dx + dy * dy < 16) return;
    drag.moved = true;
    root.classList.add('panning');
    Z.x = drag.x + dx; Z.y = drag.y + dy;
    zoomed();
  }
  function up() {
    if (lift) { letGo(true); return; }
    if (!drag) return;
    dragged = drag.moved;
    drag = null;
    root.classList.remove('panning');
  }
  // A name carried onto another column merges the two: into it when it is merged already, else as a new merged violin
  // where the other was, named at once. Columns it can't merge with take nothing.
  let lift = null;
  function carry(e, px, py) {
    const dx = px - lift.px, dy = py - lift.py;
    if (!lift.moved && dx * dx + dy * dy < 25) return;
    if (!lift.moved) {
      lift.moved = true;
      root.classList.add('lifting');
      X.hideTip();
      pill.hidden = true;
      X.edit.showHide(null);
      clearTimeout(cardSoon);
    }
    const [lx, ly] = toLayer(px, py), from = G.p.cols[lift.c];
    const el = e.target.closest && e.target.closest('[data-col]');
    const c = el ? Number(el.dataset.col) : colAt(lx, ly);
    lift.to = c !== null && X.layout.canMerge(from.id, G.p.cols[c].id) ? c : null;
    X.edit.showLift(from.label, px, py, lift.to !== null ? G.p.cols[lift.to].id : null);
    X.schedule(drawHover);
  }
  function letGo(drop) {
    const l = lift;
    lift = null;
    root.classList.remove('lifting');
    X.edit.showLift(null);
    if (!l.moved) return;
    dragged = true;
    X.schedule(drawHover);
    if (!drop || l.to === null) return;
    const a = G.p.cols[l.c].id, b = G.p.cols[l.to].id;
    X.picked.delete(a); X.picked.delete(b);
    if (X.layout.isMerged(b)) { flash(X.layout.join(a, b)); return; }
    const id = X.layout.merge([a, b], '', b);
    flash(id);
    requestAnimationFrame(() => X.edit.rename(id));
  }
  // Where a change landed, lit for a moment.
  let lit = null;
  function flash(id) {
    lit = { id, t: performance.now() };
    const step = (now) => { drawHover(); if (lit && now - lit.t < 900) requestAnimationFrame(step); else lit = null; };
    requestAnimationFrame(step);
  }
  // A name's place on the stage, for typing over it: where its line meets it, its slant, its length and the zoom.
  function nameAt(id) {
    const c = G ? G.p.cols.findIndex((col) => col.id === id) : -1;
    if (c < 0) return null;
    return { x: Z.x + (G.xOf(c) + 3) * Z.z, y: Z.y + (G.TR.y0 + G.labelY) * Z.z, z: Z.z, deg: Number(G.deg), len: G.lens[c], size: SIZE };
  }

  // All of it again, gliding there.
  function fit() {
    if (Z.z === 1) return;
    const from = { ...Z }, start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 220), e = 1 - Math.pow(1 - t, 3);
      Z.z = from.z + (1 - from.z) * e; Z.x = from.x * (1 - e); Z.y = from.y * (1 - e);
      zoomed();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function dbl(e, px, py) {
    const name = e.target.closest && e.target.closest('[data-col]');
    if (name) {
      clearTimeout(cardSoon);
      const col = G.p.cols[Number(name.dataset.col)];
      if (!col.root) { X.panel.closeCard(); X.edit.rename(col.id); }
      return;
    }
    const [lx, ly] = toLayer(px, py);
    if (!(e.target.closest && e.target.closest('.hit, [data-pill], #v-factor-menu')) && !nearestDot(lx, ly)) fit();
  }

  // The canvases again, at the density the screen and the zoom need, over what is now on screen.
  function rezoom() {
    if (!G) return;
    points.resize(G.W, G.H, view(G.W, G.H));
    drawHeat();
    drawHover();
  }

  X.violins = { init, render, drawHover, move, leave, click, rezoom, wheel, down, up, dbl, fit, nameAt, flash, get G() { return G; }, invalidate() { lastKey = null; },
    closeMenu, get menuOpen() { return menuId !== null; } };
})();
