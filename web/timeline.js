// The Timeline's waterfall, as in Jaeger, over every compilation in view: one row per span, compilations one after
// another in the order they ran, run after run, each followed by its spans in tree order, on a wall-clock axis with
// long idle stretches folded and each run on its own clock. Spans fold into their parents, one at a time or a level
// at a time; asynchronous ones are hollow. The stretch of time shown is the one the flame chart shares (X.nav), and
// zoom changes the scale without changing the rows. Rows are drawn only where the list is scrolled to.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, esc, clamp } = X;
  const ROW = 26, INDENT = 16, MAXH = 8e6;

  let root, head, rowsEl, gridEl, layerEl;
  let M = null;              // every row the folding leaves, in order, with its display times
  let rows = null;           // the rows in the stretch shown: indices into M
  let hi = null;             // the span picked: compilation and row
  let pending = null;        // a compilation whose rows to bring up when the view next opens
  let pickedHere = false;    // the selection came from a row here, which is on screen already
  const folded = new Set();  // spans folded into themselves, by key()
  let level = Infinity;      // the depth the fold buttons last showed down to
  let frame = 0, rebuildTimer = 0;
  let critical = false;

  const key = (i, r) => i * 1e6 + r;

  function init() {
    root = $('timeline');
    const chevrons = (d) => `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const fold = (to, title, d) => `<button type="button" data-level="${to}" title="${title}" aria-label="${title}">${chevrons(d)}</button>`;
    root.innerHTML = '<div class="tl-head"><div class="tl-axis-row"><div class="tl-headcell"><span class="tl-th">Span</span><span class="tl-folds" role="group" aria-label="Fold spans">'
      + fold('none', 'Collapse all', 'M3.5 6.5 7 3l3.5 3.5M3.5 11 7 7.5l3.5 3.5') + fold('less', 'Collapse a level', 'M3.5 9 7 5.5 10.5 9')
      + fold('more', 'Expand a level', 'M3.5 5 7 8.5 10.5 5') + fold('all', 'Expand all', 'M3.5 3 7 6.5 10.5 3M3.5 7.5 7 11l3.5-3.5')
      + '</span><button class="tl-critical-toggle" aria-pressed="false" title="Highlight the recorded critical path; ordinary calls are assumed sequential">Critical path</button></div><div class="tl-ticks" title="Time since the first span in view began; each run counts from its own"></div></div></div>'
      + '<div class="tl-rows"><div class="tl-grid"></div><div class="tl-layer"></div></div>';
    head = root.firstChild;
    if (X.meta.sampled_cpu) {
      head.querySelector('.tl-critical-toggle').hidden = true;
      head.querySelector('.tl-th').textContent = 'Stack segment';
      head.querySelector('.tl-ticks').title = 'Sampled CPU time in recording order; independent units are concatenated';
    }
    head.querySelector('.tl-critical-toggle').addEventListener('click', e => {
      critical = !critical; e.currentTarget.setAttribute('aria-pressed', String(critical)); schedule();
    });
    rowsEl = root.lastChild;
    gridEl = rowsEl.firstChild;
    layerEl = rowsEl.lastChild;
    root.tabIndex = 0;
    root.addEventListener('scroll', () => schedule());
    root.addEventListener('wheel', e => {
      if (!rows || e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const g = scrollGeometry(), scale = e.deltaMode === 1 ? ROW : e.deltaMode === 2 ? g.view : 1;
      scrollToOffset(g.v + e.deltaY * scale);
      schedule();
    }, {passive:false});
    root.addEventListener('keydown', e => {
      if (!rows || e.ctrlKey || e.metaKey || e.altKey || e.target.matches('input,textarea,[contenteditable]')) return;
      const g = scrollGeometry(), targets = {ArrowUp:g.v-ROW, ArrowDown:g.v+ROW,
        PageUp:g.v-g.view, PageDown:g.v+g.view, Home:0, End:g.total};
      if (!(e.key in targets)) return;
      e.preventDefault(); scrollToOffset(targets[e.key]); schedule();
    });
    // Span trees arrive in files of a few hundred compilations; each brings their spans in, keeping the view still.
    X.on('chunk', () => {
      if (S.view === 'timeline' && M) {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => rebuild(), 250);
      } else if (X.chunksLoaded() === X.chunkCount) warm();
    });
    X.on('name', () => { if (S.view === 'timeline') schedule(); });
    // The shared stretch moved: list what is in it; a compilation shown brings its rows up.
    // While the window glides only the bars move; the rows settle when it stops, so none go before it gets there.
    X.on('window', (opts) => {
      if (opts.unit !== undefined) pending = opts.unit;
      if (S.view !== 'timeline' || !M) return;
      if (opts.animating) { schedule(); return; }
      filter();
      bringUp();
      if (opts.focus) {
        const k = rowIndex(opts.focus.unit, opts.focus.row);
        if (k >= 0) scrollToRow(Math.max(0, k - 2));
      }
      schedule();
    });
    // A span picked in the flame graph is picked here too.
    const show = X.panelShowSpan;
    X.panelShowSpan = (unit, row) => { show(unit, row); hi = { unit, row }; schedule(); };

    layerEl.addEventListener('click', (e) => {
      const fold = e.target.closest('[data-fold]');
      if (fold) { toggle(Number(fold.dataset.fold)); return; }
      const el = e.target.closest('[data-j]');
      if (!el || !M) return;
      const j = Number(el.dataset.j), unit = M.U[j], row = M.R[j];
      hi = hi && hi.unit === unit && hi.row === row ? null : { unit, row };
      pickedHere = true;
      X.select(unit, { keepWindow: true });
      pickedHere = false;
      X.flame.highlightSpan(hi ? unit : null, hi ? row : null);
      schedule();
    });
    layerEl.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-j]');
      if (!el || !M || e.target.closest('[data-fold]')) return;
      const j = Number(el.dataset.j), pad = Math.max((M.D1[j] - M.D0[j]) * 0.05, 1e-3);
      window.getSelection()?.removeAllRanges();
      X.nav.set(M.D0[j] - pad, M.D1[j] + pad, { animate: true, push: true, focus: { unit: M.U[j], row: M.R[j] } });
    });
    layerEl.addEventListener('pointermove', (e) => {
      const el = e.target.closest('[data-j]');
      if (!el || !M) { X.hideTip(); return; }
      const st = $('stage').getBoundingClientRect();
      X.tip(tipFor(Number(el.dataset.j)), e.clientX - st.left, e.clientY - st.top);
    });
    layerEl.addEventListener('pointerleave', () => X.hideTip());
    // Ctrl and the wheel over the bars zoom around the pointer.
    rowsEl.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !M) return;
      e.preventDefault();
      const b = gridEl.getBoundingClientRect(), f = clamp((e.clientX - b.left) / b.width, 0, 1), w = X.nav.win();
      const at = w[0] + f * (w[1] - w[0]), span = (w[1] - w[0]) * Math.exp(e.deltaY * 0.004);
      X.nav.set(at - f * span, at + (1 - f) * span);
    }, { passive: false });
    head.addEventListener('click', (e) => {
      const b = e.target.closest('[data-level]');
      if (!b || !M) return;
      const deepest = M.maxDepth, now = Math.min(level, deepest);
      setLevel({ none: 0, less: Math.max(0, now - 1), more: now + 1 >= deepest ? Infinity : now + 1, all: Infinity }[b.dataset.level]);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The model.

  // A compilation's spans as its file has them, with each one's depth, subtree size and number of children. Small,
  // so kept once read.
  const trees = new Map();
  function treeOf(i) {
    let t = trees.get(i);
    if (t) return t;
    const u = data.units[i], chunk = X.chunk(u.k);
    if (!chunk) return null;
    const tree = chunk.trees[i - u.k * X.meta.chunk], flat = tree.rows, n = flat.length / 5;
    const depth = new Int16Array(n), size = new Int32Array(n).fill(1), kids = new Int32Array(n);
    let end = 0, maxDepth = 0;
    for (let r = 0; r < n; r++) {
      const p = flat[5 * r + 1];
      depth[r] = p >= 0 ? depth[p] + 1 : 0;
      maxDepth = Math.max(maxDepth, depth[r]);
      end = Math.max(end, (flat[5 * r + 2] + flat[5 * r + 3]) / 1000);
    }
    // Rows are in tree order, so a span's descendants follow it.
    for (let r = n - 1; r > 0; r--) { const p = flat[5 * r + 1]; size[p] += size[r]; kids[p]++; }
    t = { tree, flat, names: chunk.names, links: tree.links || [], flow: X.traceFlows(tree), n, depth, size, kids, end, maxDepth };
    trees.set(i, t);
    return t;
  }

  function build() {
    const nav = X.nav.model(), units = nav.units;
    let n = 0;
    for (const i of units) { const t = treeOf(i); n += t ? t.n : 1; }
    const U = new Int32Array(n), R = new Int32Array(n), D0 = new Float64Array(n), D1 = new Float64Array(n);
    let k = 0, maxDepth = 0;
    const unitRows = new Map();
    for (const i of units) {
      const u = data.units[i], base = nav.start[i], t = treeOf(i);
      const first = k;
      if (!t) { U[k] = i; R[k] = 0; D0[k] = base; D1[k] = base + u.ms; k++; unitRows.set(i, [first,k]); continue; }
      maxDepth = Math.max(maxDepth, t.maxDepth);
      for (let r = 0; r < t.n; r++) {
        const s = t.flat[5 * r + 2] / 1000;
        U[k] = i; R[k] = r; D0[k] = base + s; D1[k] = base + s + t.flat[5 * r + 3] / 1000; k++;
        if (folded.has(key(i, r))) r += t.size[r] - 1;
      }
      unitRows.set(i, [first,k]);
    }
    return { unitRows, key: nav.key, nav, units, U: U.subarray(0, k), R: R.subarray(0, k), D0: D0.subarray(0, k), D1: D1.subarray(0, k), n: k, maxDepth };
  }

  // Once every file is in, the trees are read and the rows laid out while the page is idle, a slice at a time, so
  // the view opens at once.
  function warm() {
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    let i = 0;
    const step = (deadline) => {
      while (i < data.units.length && (!deadline || deadline.timeRemaining() > 2)) treeOf(i++);
      if (i < data.units.length) idle(step);
      else if (S.view !== 'timeline' && (!M || M.key !== X.nav.model().key)) M = build();
    };
    idle(step);
  }

  // The rows in the stretch shown.
  function filter() {
    if(!rows||rows.length!==M.n)rows=Int32Array.from({length:M.n},(_,i)=>i);
  }

  // The model again, keeping the row at the top of the list where it is.
  function rebuild() {
    const anchor = topRow();
    M = build();
    filter();
    if (anchor) {
      const t = treeOf(anchor.unit);
      // A collapsed ancestor can replace the old top row. Keep its screen offset.
      for (let r = anchor.row; r >= 0; r = t ? t.flat[r * 5 + 1] : -1) {
        const k = rowIndex(anchor.unit, r);
        if (k >= 0) { scrollToOffset(k * ROW - anchor.offset); break; }
      }
    }
    draw();
  }

  // Every span shown down to a depth: those at it fold, those above it open. One arrow can still open or fold any.
  function setLevel(to) {
    level = to;
    folded.clear();
    if (Number.isFinite(to)) {
      for (const i of M.units) {
        const t = treeOf(i);
        if (t) for (let r = 0; r < t.n; r++) if (t.depth[r] === to && t.kids[r]) folded.add(key(i, r));
      }
    }
    rebuild();
  }

  function toggle(j) {
    const k = key(M.U[j], M.R[j]);
    if (folded.has(k)) folded.delete(k); else folded.add(k);
    rebuild();
  }

  // The rows of a compilation just shown, at the top of the list.
  function bringUp() {
    if (pending === null || !rows) return;
    const i = pending;
    pending = null;
    const range = M.unitRows.get(i);
    if (range) scrollToRow(range[0]);
  }
  function rowIndex(unit, row) {
    const range = M.unitRows.get(unit);
    if (!range) return -1;
    let [lo, hi] = range;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (M.R[mid] < row) lo = mid + 1; else hi = mid; }
    return lo < range[1] && M.R[lo] === row ? lo : -1;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The native scrollbar spans the whole recording. Wheel and keyboard movement
  // use logical pixels, independent of the browser's scroll-height limit.
  let logicalTop = 0, physicalTop = 0;
  function scrollGeometry() {
    const total = rows.length * ROW, height = Math.min(total, MAXH), view = Math.max(1, root.clientHeight - head.offsetHeight);
    const s = clamp(root.scrollTop - rowsEl.offsetTop + head.offsetHeight, 0, Math.max(0, height - view));
    if (root.scrollTop !== physicalTop) {
      logicalTop = height > view ? s * (Math.max(0, total - view) / Math.max(1, height - view)) : 0;
      physicalTop = root.scrollTop;
    }
    logicalTop = clamp(logicalTop, 0, Math.max(0, total - view));
    return { total, height, view, s, v:logicalTop };
  }
  function topRow() {
    if (!M || !rows || !rows.length) return null;
    const g = scrollGeometry(), k = clamp(Math.floor(g.v / ROW), 0, rows.length - 1);
    return { unit: M.U[rows[k]], row: M.R[rows[k]], offset:k * ROW - g.v };
  }
  function scrollToOffset(v) {
    rowsEl.style.height = `${Math.min(rows.length * ROW, MAXH) + 8}px`;
    const total = rows.length * ROW, height = Math.min(total, MAXH), view = Math.max(1, root.clientHeight - head.offsetHeight);
    logicalTop = clamp(v, 0, Math.max(0, total - view));
    const s = total > view ? logicalTop * Math.max(0, height - view) / (total - view) : 0;
    root.scrollTop = s + rowsEl.offsetTop - head.offsetHeight;
    physicalTop = root.scrollTop;
  }
  function scrollToRow(k) { scrollToOffset(k * ROW); }

  // ---------------------------------------------------------------------------------------------------------
  // Drawing.

  function schedule() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }

  function render() {
    if (S.view !== 'timeline') return;
    root.style.top = `${X.contentTop()}px`;
    root.style.setProperty('--name', `${clamp(Math.round(root.clientWidth * 0.3), 240, 420)}px`);
    if (!M || M.key !== X.nav.model().key) { M = build(); X.prefetchChunks(); }
    filter();
    bringUp();
    draw();
  }

  function draw() {
    if (S.view !== 'timeline' || !M || !rows) return;
    const T = X.T, w = X.nav.win(), span = w[1] - w[0];
    rowsEl.style.height = `${Math.min(rows.length * ROW, MAXH) + 8}px`;
    // Ticks on the axis and through the rows, around each run's title; a folded idle stretch is only a break in the
    // axis, and where one run ends and the next begins a line runs down through the rows.
    const ticks = head.querySelector('.tl-ticks'), tw = ticks.clientWidth;
    const labels = X.runLabels(M.nav, w[0], w[1], tw);
    let marks = '', lines = '';
    // Time since the first compilation in view began: in a waterfall it is durations that are read, not the clock.
    for (const { d, label } of X.elapsedTicks(M.nav, w[0], w[1], tw, labels)) {
      const x = (d - w[0]) / span * 100;
      if (x > 96) continue;
      marks += `<i style="left:${pct(x)}"></i><span style="left:${pct(x)}">${label}</span>`;
      lines += `<i style="left:${pct(x)}"></i>`;
    }
    for (const l of labels) marks += `<b style="left:${l.x.toFixed(1)}px" title="${esc(X.runTitle(l.run))}">${esc(l.text)}</b>`;
    for (const g of M.nav.gaps) {
      const x = ((g.d0 + g.d1) / 2 - w[0]) / span * 100;
      if (x > 0 && x < 100) marks += `<u style="left:${pct(x)}" title="${X.fmtSpan(g.r1 - g.r0, g.r1 - g.r0)} idle, folded"></u>`;
    }
    for (const d of M.nav.breaks) {
      const x = (d - w[0]) / span * 100;
      if (x > 0 && x < 100) { marks += `<s style="left:${pct(x)}"></s>`; lines += `<s style="left:${pct(x)}"></s>`; }
    }
    ticks.innerHTML = marks;
    for (const d of X.nav.unitBreaks(w[0], w[1], tw)) lines += `<s style="left:${pct((d-w[0])/span*100)}"></s>`;
    gridEl.innerHTML = lines;
    // Only the rows on screen, and a few around them.
    const g = scrollGeometry();
    const a = Math.max(0, Math.floor(g.v / ROW) - 8), b = Math.min(rows.length, Math.ceil((g.v + g.view) / ROW) + 8);
    const html = [], at = new Map();
    for (let k = a; k < b; k++) {
      const j = rows[k], y = g.s + k * ROW - g.v;
      html.push(rowHtml(j, y, T, w));
      if (M.U[j] === S.sel) at.set(M.R[j], { j, y });
    }
    layerEl.innerHTML = html.length ? html.join('') + flowsHtml(at, g, w) : '<p class="tl-empty">No spans in this stretch of time.</p>';
  }

  // The selected compilation's links between rows on screen, as Perfetto draws flows: an arrow from what a span
  // waited for to its end (depends_on), or from what it followed to its start (follows_from).
  function flowsHtml(at, g, w) {
    const t = S.sel !== null ? treeOf(S.sel) : null;
    if (!t || !t.links.length || !at.size) return '';
    const nameW = parseFloat(root.style.getPropertyValue('--name')) || 0, tw = gridEl.clientWidth, span = w[1] - w[0];
    const xOf = (d) => nameW + clamp((d - w[0]) / span, 0, 1) * tw;
    let paths = '';
    for (let k = 0; k < t.links.length; k += 3) {
      if (!t.links[k + 2]) continue;
      const a = at.get(t.links[k]), b = at.get(t.links[k + 1]);
      if (!a || !b) continue;
      let x1 = xOf(M.D1[b.j]), x2 = xOf(t.links[k + 2] === 2 ? M.D0[a.j] : M.D1[a.j]);
      const y1 = b.y - g.s + ROW / 2, y2 = a.y - g.s + ROW / 2, near = Math.abs(x2 - x1) < 24;
      // Nearly coincident endpoints bow left without moving their causal timestamps.
      const d = near ? -18 : Math.max(10, (x2 - x1) / 2), c1 = x1 + d, c2 = near ? x2 + d : x2 - d, s = x2 >= c2 ? 1 : -1;
      paths += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}C${c1.toFixed(1)} ${y1.toFixed(1)} ${c2.toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}"/>`
        + `<path class="head" d="M${x2.toFixed(1)} ${y2.toFixed(1)}l${-6 * s} -3.5v7z"/>`;
    }
    return paths ? `<svg class="tl-flows" style="top:${g.s.toFixed(1)}px;height:${g.view}px" aria-hidden="true">${paths}</svg>` : '';
  }

  const pct = (v) => `${v.toFixed(3)}%`;
  function criticalIntervals(t, r, collapsed) {
    const cp = X.criticalPath(t.tree, t.flow), f = t.flat, a = f[r*5+2], b = a+f[r*5+3];
    const source = collapsed ? [...cp.segments].filter(([fr]) => fr === t.flow.root[r] || (fr > r && fr < r+t.size[r])).flatMap(([,spans]) => spans)
      : cp.segments.get(t.flow.root[r]) || [];
    const spans = source.filter(v => v[1] > a && v[0] < b).map(v => [Math.max(a,v[0]),Math.min(b,v[1])]);
    if (collapsed) {
      const merged = [];
      for (const v of spans.sort((a,b)=>a[0]-b[0])) {
        const last = merged[merged.length-1];
        if (last && v[0] <= last[1]) last[1] = Math.max(last[1],v[1]); else merged.push(v);
      }
      return merged;
    }
    // Show exclusive segments on open rows, leaving children to carry their own highlights.
    const children = [];
    for (let q = r+1; q < r+t.size[r]; q += t.size[q]) if (!t.flow.start[q]) children.push([f[q*5+2],f[q*5+2]+f[q*5+3]]);
    children.sort((a,b) => a[0]-b[0]);
    const out = [];
    let child = 0;
    for (const [a,b] of spans) {
      let at = a;
      while (child < children.length && children[child][1] <= at) child++;
      for (let q = child; q < children.length && children[q][0] < b; q++) {
        if (children[q][0] > at) out.push([at,Math.min(b,children[q][0])]);
        at = Math.max(at,children[q][1]);
      }
      if (at < b) out.push([at,b]);
    }
    return out;
  }
  // A bar's length label: after the bar, before it near the right edge, or inside its end when it spans the track.
  function durLabel(x0, x1, text) {
    if (x1 < 0 || x0 > 100) return '';
    if (x1 < 84) return `<span class="tl-dur" style="left:${pct(Math.max(0, x1))}">${text}</span>`;
    if (x0 > 16) return `<span class="tl-dur end" style="right:${pct(clamp(100 - x0, 0, 100))}">${text}</span>`;
    return `<span class="tl-dur in" style="right:${pct(clamp(100 - x1, 0, 100))}">${text}</span>`;
  }

  function rowHtml(j, y, T, w) {
    const i = M.U[j], r = M.R[j], t = treeOf(i), u = data.units[i], span = w[1] - w[0];
    const flags = t ? t.flat[5 * r + 4] : 0, part = X.layout.partOfRow(i, r), depth = t ? t.depth[r] : 0;
    const color = r === 0 ? (T.scheme === 'dark' ? '#4a505a' : '#a9b0ba') : part >= 0 ? T.cols[part] : T.unowned;
    const async = t && t.flow.root[r] > 0;
    const x0 = (M.D0[j] - w[0]) / span * 100, x1 = (M.D1[j] - w[0]) / span * 100;
    const isFolded = folded.has(key(i, r)), kids = t ? t.kids[r] : 0;
    let highlight = '';
    if (critical && t) {
      const base = M.nav.start[i];
      for (const [a,b] of criticalIntervals(t,r,isFolded)) {
        const x = clamp((base+a/1000-w[0])/span*100,0,100), end = clamp((base+b/1000-w[0])/span*100,0,100);
        if (end > x) highlight += `<span class="tl-critical" style="left:${pct(x)};width:${pct(end-x)}"></span>`;
      }
    }
    const tw = kids ? `<button type="button" class="tl-tw" data-fold="${j}" aria-expanded="${!isFolded}" aria-label="${isFolded ? 'Open' : 'Fold'}">`
      + '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
      : '<span class="tl-tw"></span>';
    const name = t ? t.names[t.flat[5 * r]] : X.UNIT;
    let label;
    if (r === 0) {
      const side = X.sideKey(u.g);
      label = `${X.glyph(side === 'left' || side === 'right' ? side : 'marker', T[side])}<span class="nm">${esc(u.l)}</span><span class="grp">${esc(X.groupName(u.g))}</span>`;
    } else label = `<i style="background:${color}"></i><span class="nm">${esc(name)}</span>`;
    // With a compilation selected the others recede, so it stands out wherever it is.
    const cls = `tl-row${r === 0 ? ' root' : ''}${i === S.sel ? ' sel' : S.sel !== null ? ' dim' : ''}${hi && hi.unit === i && hi.row === r ? ' on' : ''}${S.name === name ? ' named' : ''}`;
    return `<div class="${cls}" data-j="${j}" data-unit="${i}" data-row="${r}" style="top:${y.toFixed(1)}px">`
      + `<div class="tl-name" style="padding-left:${4 + depth * INDENT}px">${tw}${label}`
      + `${isFolded && t ? `<em>${t.size[r] - 1}</em>` : ''}${flags & 2 ? '<span class="tl-err">error</span>' : ''}</div>`
      + `<div class="tl-track"><span class="tl-bar${async ? ' async' : ''}" style="left:${pct(x0)};width:${pct(Math.max(0, x1 - x0))};--c:${color};--f:${X.mix(color, T.bg, 0.82)}"></span>`
      + `${highlight}${durLabel(x0, x1, X.fmtUs(M.D1[j] - M.D0[j]))}</div></div>`;
  }

  function tipFor(j) {
    const i = M.U[j], r = M.R[j], u = data.units[i], t = treeOf(i);
    const criticalNote = critical && t ? (() => {
      const cp = X.criticalPath(t.tree,t.flow);
      return cp.reasons.length ? `Critical path estimate: ${cp.reasons.join('; ')}` : 'Critical path: sequential calls with recorded dependencies';
    })() : '';
    if (r === 0 || !t) {
      const top = u.p ? data.partition.map((p, q) => [p.label, u.p[q]]).sort((a, b) => b[1] - a[1]).slice(0, 2) : [];
      return [u.l, X.groupName(u.g), `${X.UNIT} ${X.fmtMs(u.ms)}`, ...top.map(([label, v]) => `${label} ${X.fmtPct(v)}`), criticalNote].filter(Boolean);
    }
    const f = t.flat, flags = f[5 * r + 4], part = X.layout.partOfRow(i, r), dur = f[5 * r + 3] / 1000;
    // Self time: less what its synchronous children cover.
    let inner = 0;
    for (let q = r + 1; q < r + t.size[r]; q++) if (t.depth[q] === t.depth[r] + 1 && !(f[5 * q + 4] & 1)) inner += f[5 * q + 3] / 1000;
    const lines = [t.names[f[5 * r]], `${X.fmtMs(dur)} · self ${X.fmtMs(Math.max(0, dur - inner))}`, `from ${X.fmtMs(f[5 * r + 2] / 1000)} into ${u.l}`];
    lines.push(part >= 0 ? data.columns[part].label : '');
    if (t.flow.root[r] > 0) lines.push(t.flow.start[r] ? 'Starts a separate logical flow' : 'Within a separate logical flow');
    if (criticalNote) lines.push(criticalNote);
    return lines.filter((l, k) => l || k < 3);
  }

  // ---------------------------------------------------------------------------------------------------------

  X.timeline = {
    init, render,
    // The window follows a selection through X.nav; here its rows come up, unless it was picked from them, and the
    // other compilations' rows recede.
    selectionChanged(keepWindow) {
      if (!keepWindow) hi = null;
      if (S.sel !== null && !pickedHere) pending = S.sel;
      if (S.view === 'timeline' && M) { bringUp(); schedule(); }
    },
    invalidate() { M = null; },
  };
})();
