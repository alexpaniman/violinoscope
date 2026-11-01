// Spans stacked on one canvas, in two modes as speedscope has them. The Timeline's flame chart (by time): every
// compilation in view on one line where it really ran, run after run, its asynchronous spans on a track per name
// below, in lanes that split only where they overlap; the stretch of time shown is the one the waterfall shares
// (X.nav), zoomed and panned like Perfetto. The Profile's flame graph (left heavy): spans with the same path merged,
// heaviest first, over the selected compilation or else everything in view: the compiler's line as one chart, then
// each asynchronous track as one, as the flame chart has them. Both have the strip above: by time it shows when each
// compilation ran, in left heavy the merged chart in miniature.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, clamp } = X;
  X.flameWindow = {
    zoom(d0, d1, fraction, factor, extent) {
      const span = d1 - d0, at = d0 + fraction * span, size = X.clamp(span * factor, 1e-6, extent * 1.2);
      return [at - fraction * size, at + (1 - fraction) * size];
    },
    pan(d0, d1, fraction) { const d = fraction * (d1 - d0); return [d0 + d, d1 + d]; },
  };
  const ROWH = 15, AXIS = 26, LEFT = 16, RIGHT = 20, ROWS = 8, ASYNC_HEAD = 12, TRACK_HEAD = 15;

  let root, canvas, ctx, W = 0, H = 0;
  let M = null;              // the model: the line, time folding, merged trees
  let win = null;            // the stretch on screen, in display units: the shared one by time, heavyWin in left heavy
  let heavyWin = { d0: 0, d1: 1 }, heavyBack = [];
  const focused = () => S.tab === 'profile' && ['callers', 'callees'].includes(S.prof);
  const profileKey = () => focused() ? `${S.prof}|${S.profileRoot}` : 'flame';
  let scrollY = 0, dirty = 0, hot = null, spanHi = null, mergeTimer = 0, pendingFocus = null;

  function init() {
    root = $('flame');
    canvas = $('flame-canvas');
    ctx = canvas.getContext('2d');
    // Spans arriving: the merged chart takes them in, at most every quarter second while it is on screen.
    X.on('chunk', () => {
      if (!M) return;
      const merge = () => { M.merged = M.heavy = null; };
      if (S.view === 'flame' && S.flame === 'heavy') { clearTimeout(mergeTimer); mergeTimer = setTimeout(() => { merge(); request(); }, 250); return; }
      merge();
      if (S.view === 'flame') request();
    });
    X.on('window', opts => {
      if (opts.focus) pendingFocus = opts.focus;
      else if (opts.unit !== undefined) pendingFocus = {unit:opts.unit, row:0};
      if (S.view === 'flame' && S.flame === 'time') request();
    });
  }

  // The stretch on screen, read again wherever it is used: it moves from outside too.
  function sync() {
    if (S.flame === 'heavy') win = heavyWin;
    else { const w = X.nav.win(); win = { d0: w[0], d1: w[1] }; }
    return win;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The model.

  function build() {
    const nav = X.nav.model(), units = nav.units;
    // The line: compilations one after another. Two that really overlap would get a second line.
    const lines = [], pos = new Map();
    for (const i of units) {
      const d = nav.start[i], e = d + data.units[i].ms;
      let line = lines.find((l) => l.end <= d);
      if (!line) { line = { units: [], d0: [], d1: [], reach: [], end: -Infinity }; lines.push(line); line.number = lines.length; }
      pos.set(i, { line, j: line.units.length });
      line.units.push(i); line.d0.push(d); line.d1.push(e);
      line.reach.push(Math.max(line.reach.at(-1) ?? -Infinity, d + X.spanExtent(i)[1]));
      line.end = e;
    }
    M = { key: `${nav.key}|${profileKey()}`, nav, units, lines, pos, heavy: null };
    return M;
  }

  function model() {
    const nav = X.nav.model();
    if (!M || M.key !== `${nav.key}|${profileKey()}`) {
      cancelAnimationFrame(anim);
      build(); scrollY = 0; heavyBack = [];
    }
    return M;
  }

  // A compilation a pixel wide shows, at each depth, the part that takes most of its time there: from its spans once
  // they are in, from the summary's parts until then.
  const dominant = new Map();
  const chartCache = new Map();
  function chartSpans(i) {
    if (chartCache.has(i)) return chartCache.get(i);
    const raw = X.rawSpans(i);
    if (!raw) return null;
    const {flat:f,flow,names} = raw, parts = new Int32Array(f.length/5), asyncRows = [], levels = [];
    let maxDepth = 0;
    for (let r=0; r<f.length/5; r++) {
      if (!flow.root[r]) maxDepth = Math.max(maxDepth,flow.depth[r]);
      parts[r] = X.layout.partOfRow(i,r);
      if (!flow.root[r]) (levels[flow.depth[r]] ||= []).push(r);
      if (flow.root[r]) asyncRows.push(r);
    }
    const index = levels.map(rows => {
      rows.sort((a,b)=>f[a*5+2]-f[b*5+2] || a-b);
      const reach = new Float64Array(rows.length);
      rows.forEach((r,k)=>{reach[k]=Math.max(k ? reach[k-1] : -Infinity,f[r*5+2]+f[r*5+3]);});
      return {rows:Int32Array.from(rows),reach};
    });
    const value = {...raw, levels:index, parts, asyncRows:Int32Array.from(asyncRows), maxDepth, links:raw.tree.links || []};
    chartCache.set(i,value); return value;
  }
  function* visibleRows(sp, l, a, scale) {
    const f = sp.flat, lo = (LEFT-a)/scale*1000, hi = (W-RIGHT-a)/scale*1000;
    const first = Math.max(0,Math.floor((X.contentTop()+AXIS-l.y0)/ROWH));
    const last = Math.min(sp.levels.length,Math.ceil((H-l.y0)/ROWH));
    for (let depth=first; depth<last; depth++) {
      const line = sp.levels[depth];
      if (!line) continue;
      let left=0, right=line.rows.length;
      while (left<right) { const mid=(left+right)>>>1; if (line.reach[mid]<lo) left=mid+1; else right=mid; }
      for (let k=left; k<line.rows.length; k++) {
        const r=line.rows[k];
        if (f[r*5+2]>hi) break;
        yield r;
      }
    }
    yield* sp.asyncRows;
  }
  function dominantOf(i) {
    let d = dominant.get(i);
    if (d && (d.spans || !X.hasSpans(i))) return d;
    if (X.hasSpans(i)) {
      const sums = Array.from({ length: ROWS }, () => new Map());
      // Its asynchronous lanes, by track, each with the part of the longest span on it.
      const lanes = new Map();
      X.eachSpan(i,s => {
        if (s.lane < 0) {
          if (s.flowDepth < ROWS) sums[s.flowDepth].set(s.part,(sums[s.flowDepth].get(s.part)||0)+s.dur);
          return;
        }
        const k = `${s.track}:${s.lane}:${s.flowDepth}`;
        if (!lanes.has(k) || lanes.get(k)[1] < s.dur) lanes.set(k, [s.part, s.dur]);
      });
      while (sums.length && !sums[sums.length-1].size) sums.pop();
      d = sums.map((m, depth) => depth === 0 ? -2 : [...m].sort((a,b)=>b[1]-a[1])[0]?.[0] ?? -1);
      d.lanes = [...lanes].map(([k, [part]]) => [...k.split(':').map(Number), part]);
      d.spans = true;
    } else {
      const u = data.units[i];
      d = [-2];
      for (let depth = 0; depth < 3; depth++) {
        let best = -1, bv = 0;
        for (let k = 0; k < X.NC; k++) if (X.depthIdx[k] === depth && u.s[k] > bv) { bv = u.s[k]; best = k; }
        d.push(best);
      }
      d.lanes = [];
    }
    dominant.set(i, d);
    return d;
  }

  // Left heavy, as in speedscope: spans with the same path merged, heaviest first, on an axis of their summed time:
  // over what is selected, a compilation, or else every compilation in view. As in the flame chart, the compiler's
  // spans make one chart and each asynchronous track another, so the time spent beside the compiler shows in full:
  // spans that overlap add up. Everything in view is merged once (M.merged); a selection only merges its own spans.
  // dur, inner and n read a node's time, its children's, and its count, for what is shown.
  function mergeHeavy() {
    if (focused()) {
      const moved = !M.heavy || M.heavy.sel !== S.sel;
      const one = S.sel !== null && M.pos.has(S.sel),
        source = X.spans.focusTree(S.profileRoot, one ? [S.sel] : M.units),
        tree = source[S.prof], nodes = [{name:'',depth:-1,kids:new Map(),dur:0,inner:0,n:0,part:-1}], roots = [];
      const append = (tree, parent, depth) => {
        const k = nodes.length, kids = new Map();
        nodes.push({...tree, depth, kids, inner:[...tree.kids.values()].reduce((sum,n)=>sum+n.dur,0)});
        nodes[parent].kids.set(tree.name,k);
        for (const child of tree.kids.values()) append(child,k,depth+1);
        return k;
      };
      append(tree,0,0);
      if (S.prof === 'callees') for (const flow of source.flows) {
        const root = nodes.length;roots.push(root);
        nodes.push({name:'',depth:-1,kids:new Map(),dur:flow.tree.dur,inner:0,n:0,part:-1});
        append(flow.tree,root,0);
      }
      const total = tree.dur || 1, dur = k=>nodes[k].dur,
        chart = root=>chartTree(nodes,root,dur,1/total), sync=chart(0), tracks=roots.map(chart);
      M.heavy = {nodes,sync,tracks,total,units:source.loaded,all:source.all,unit:one?S.sel:null,sel:S.sel,
        focus:S.profileRoot,direction:S.prof,origins:source.origins,
        extent:Math.max(1,...tracks.map(t=>t.width)),dur,inner:k=>nodes[k].inner,n:k=>nodes[k].n};
      if (moved) heavyWin = {d0:0,d1:M.heavy.extent,key:M.key};
      return;
    }
    if (!M.merged) M.merged = mergeAll();
    const { nodes, into, chart, roots } = M.merged, moved = !M.heavy || M.heavy.sel !== S.sel;
    M.heavy = Object.assign({}, M.merged, { unit: null, sel: S.sel, dur: (k) => nodes[k].dur, inner: (k) => nodes[k].inner, n: (k) => nodes[k].n });
    if (S.sel !== null && M.pos.has(S.sel) && X.hasSpans(S.sel)) {
      const sp = X.spansOf(S.sel), own = new Float64Array(nodes.length), inner = new Float64Array(nodes.length);
      const count = new Float64Array(nodes.length), map = new Int32Array(sp.rows.length);
      sp.rows.forEach((s, r) => {
        const pk = s.parent >= 0 ? map[s.parent] : 0, p = into(pk, s), k = nodes[p].kids.get(s.name);
        map[r] = k;
        own[k] += s.dur;
        count[k]++;
        if (p === pk) inner[pk] += s.dur;
      });
      let total = 0;
      for (const k of nodes[0].kids.values()) total += own[k];
      total = total || 1;
      const mine = (k) => own[k], sync = chart(0, mine, 1 / total), tracks = roots.map((r) => chart(r, mine, 1 / total));
      Object.assign(M.heavy, { unit: S.sel, sync, tracks, total, units: 1, extent: Math.max(1, ...tracks.map((t) => t.width)),
        dur: mine, inner: (k) => inner[k], n: (k) => count[k] });
    }
    // Another selection starts on all of its chart.
    if (moved) heavyWin = { d0: 0, d1: M.heavy.extent, key: M.key };
  }
  function mergeAll() {
    const units = M.units;
    let loaded = 0;
    // Node 0 is the root of the compiler's chart, and 1 + k that of asynchronous track k.
    const roots = X.TRACKS.map((t, k) => 1 + k);
    const nodes = [0, ...roots].map((r) => ({ name: '', part: -1, depth: -1, async: r > 0, kids: new Map(), dur: 0, n: 0, inner: 0 }));
    // Only a new flow starts at its track's root. Ordinary descendants remain under their flow's parent.
    const into = (pk, s) => (s.flowStart ? 1 + s.track : pk);
    for (const i of units) {
      if (!X.hasSpans(i)) continue;
      const map = new Int32Array(X.rawSpans(i).flat.length / 5);
      loaded++;
      X.eachSpan(i, (s, r) => {
        const pk = s.parent >= 0 ? map[s.parent] : 0, p = into(pk, s);
        let k = nodes[p].kids.get(s.name);
        if (k === undefined) {
          k = nodes.length;
          nodes.push({ name: s.name, part: s.part, depth: nodes[p].depth + 1, async: nodes[p].async, kids: new Map(), dur: 0, n: 0, inner: 0 });
          nodes[p].kids.set(s.name, k);
        }
        nodes[k].dur += s.dur;
        nodes[k].n++;
        // A synchronous child's time is not its parent's own.
        if (p === pk) nodes[pk].inner += s.dur;
        map[r] = k;
      });
    }
    for (const root of [0, ...roots]) for (const k of nodes[root].kids.values()) nodes[root].dur += nodes[k].dur;
    const total = nodes[0].dur || 1;
    const chart = (root, weight, scale) => chartTree(nodes, root, weight, scale);
    const all = (k) => nodes[k].dur;
    const sync = chart(0, all, 1 / total), tracks = roots.map((r) => chart(r, all, 1 / total));
    if (loaded < units.length) X.prefetchChunks();
    return { nodes, into, chart, roots, total, sync, tracks, units: loaded, all: units.length, extent: Math.max(1, ...tracks.map((t) => t.width)) };
  }

  // A chart: each node as wide as its weight, children heaviest first, squeezed into their parent where they ran
  // beside each other and together outweigh it.
  function chartTree(nodes, root, weight, scale) {
    const rects = [];
    let maxDepth = -1;
    const lay = (k, x0, sc) => {
      const node = nodes[k];
      if (node.depth >= 0) { rects.push({ x0, x1: x0 + weight(k) * sc, depth: node.depth, node, k, w: weight(k) }); maxDepth = Math.max(maxDepth, node.depth); }
      const list = [...node.kids.values()].filter((j) => weight(j) > 0).sort((a, b) => weight(b) - weight(a));
      const sum = list.reduce((acc, j) => acc + weight(j), 0);
      const inner = node.depth >= 0 && sum > weight(k) ? weight(k) / sum : 1;
      let x = x0;
      for (const j of list) { lay(j, x, sc * inner); x += weight(j) * sc * inner; }
    };
    lay(root, 0, scale);
    return { rects, maxDepth, width: rects.reduce((m, rc) => Math.max(m, rc.x1), 0) };
  }

  const heavyColor = (node, T) => (node.depth === 0 && !node.async ? (T.scheme === 'dark' ? '#4a505a' : '#a9b0ba') : node.part >= 0 ? T.cols[node.part] : T.unowned);

  // The overview strip in left heavy: the merged chart in miniature.
  function drawMini(c, w, h, T) {
    model();
    if (!M.heavy || M.heavy.sel !== S.sel) mergeHeavy();
    const hv = M.heavy, rows = Math.max(1, hv.sync.maxDepth + 1), rh = (h - 6) / rows, ext = hv.extent;
    const width = Math.max(1, Math.ceil(w)), height = Math.max(1, Math.ceil(h - 6));
    const pixels = new Int32Array(width * height).fill(-1), weights = new Float32Array(pixels.length);
    // Many call paths occupy the same minimap pixel. Paint its widest contributor once.
    hv.sync.rects.forEach((rc, k) => {
      const y = Math.min(height - 1, Math.floor(rc.depth * rh)), a = Math.max(0, Math.floor(rc.x0 / ext * width));
      const b = Math.min(width, Math.max(a + 1, Math.ceil(rc.x1 / ext * width))), weight = rc.x1 - rc.x0;
      for (let x = a; x < b; x++) { const p = y * width + x; if (weight > weights[p]) { weights[p] = weight; pixels[p] = k; } }
    });
    for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
      const k = pixels[y * width + x];
      let end = x + 1;
      while (end < width && pixels[y * width + end] === k) end++;
      if (k >= 0) { c.fillStyle = heavyColor(hv.sync.rects[k].node, T); c.fillRect(x, 3 + y, end - x, Math.max(1, rh - .5)); }
      x = end;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The window.

  // Everything: all of the time shown, or all of the merged chart.
  function fit(animate) {
    if (S.flame === 'heavy') setWindow(0, heavyExtent(), animate);
    else X.nav.fitAll();
  }
  function heavyExtent() {
    model();
    if (!M.heavy || M.heavy.sel !== S.sel) mergeHeavy();
    return M.heavy.extent;
  }

  // By time the shared stretch moves, and both views follow; left heavy has its own.
  let anim = 0;
  function setWindow(d0, d1, animate, remember = animate) {
    if (S.flame === 'time') { X.nav.set(d0, d1, { animate, push: animate }); return; }
    cancelAnimationFrame(anim);
    if (remember && (d0 !== heavyWin.d0 || d1 !== heavyWin.d1)) { heavyBack.push([heavyWin.d0, heavyWin.d1]); if (heavyBack.length > 100) heavyBack.shift(); }
    if (!animate) { heavyWin = { d0, d1, key: heavyWin.key }; request(); X.nav.draw(); return; }
    const a = { ...heavyWin }, start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 220), e = 1 - Math.pow(1 - k, 3);
      // Glide in log space for the width, so zooming feels even.
      const wa = a.d1 - a.d0, wb = d1 - d0, w = Math.exp(Math.log(wa) + (Math.log(wb) - Math.log(wa)) * e);
      const ca = (a.d0 + a.d1) / 2, cb = (d0 + d1) / 2, c = ca + (cb - ca) * e;
      heavyWin = { d0: c - w / 2, d1: c + w / 2, key: a.key };
      paint();
      X.nav.draw();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function zoomAt(px, factor) {
    sync();
    if (S.flame === 'heavy') { setWindow(...X.flameWindow.zoom(win.d0, win.d1, (px - LEFT) / (W - LEFT - RIGHT), factor, heavyExtent())); return; }
    const span = win.d1 - win.d0, at = win.d0 + (px - LEFT) / (W - LEFT - RIGHT) * span;
    const ns = S.flame === 'heavy' ? clamp(span * factor, 1e-6, 1.2 * heavyExtent()) : span * factor;
    setWindow(at - (at - win.d0) * ns / span, at + (win.d1 - at) * ns / span);
  }
  function pan(dxPx) {
    sync();
    setWindow(...X.flameWindow.pan(win.d0, win.d1, dxPx / (W - LEFT - RIGHT)));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Painting.

  function request() { if (!dirty) dirty = requestAnimationFrame(() => { dirty = 0; paint(); }); }

  // Prefix maxima retain every compilation whose async tail reaches the window, however many roots ended since.
  function visible(line) {
    let lo = 0, hi = line.units.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (line.reach[m] < win.d0) lo = m + 1; else hi = m; }
    let end = lo;
    while (end < line.units.length && line.d0[end] <= win.d1) end++;
    return [lo, end];
  }

  const detailed = (i, scale) => {
    const [lo, hi] = X.spanExtent(i);
    return Math.max(data.units[i].ms, hi - lo) * scale >= 3;
  };

  // Lanes of each asynchronous track in the window: as many as its busiest moment there needs. A compilation wide
  // enough to draw its spans counts only the lanes of its spans in the window; a narrower one, all of its lanes.
  function asyncLanes() {
    const n = Array.from({length:X.TRACKS.length}, () => []), px = (W - LEFT - RIGHT) / (win.d1 - win.d0);
    if (!X.TRACKS.length) return n;
    for (const line of M.lines) {
      const [lo, end] = visible(line);
      for (let j = lo; j < end; j++) {
        const i = line.units[j];
        if (detailed(i, px) && X.hasSpans(i)) {
          const {flat:f,flow,names,asyncRows} = chartSpans(i);
          for (const r of asyncRows) {
            const fr=flow.root[r],track=X.trackIndex.get(names[f[fr*5]]),lane=f[fr*5+4]>>>10;
            const a = line.d0[j] + f[r*5+2]/1000;
            if (a <= win.d1 && a + f[r*5+3]/1000 >= win.d0) n[track][lane] = Math.max(n[track][lane] || 0, flow.depth[r] + 1);
          }
        } else {
          const t = X.trackDepthsOf(i);
          if (t) t.forEach((lanes, k) => lanes.forEach((depth, lane) => { n[k][lane] = Math.max(n[k][lane] || 0, depth); }));
        }
      }
    }
    return n;
  }

  function layout() {
    const top = X.contentTop() + AXIS;
    let y = top + 6 - scrollY;
    const px = (W-LEFT-RIGHT)/(win.d1-win.d0);
    const lines = M.lines.flatMap((line) => {
      let depth = ROWS;
      const [lo,end] = visible(line);
      if (lo === end) return [];
      const heading = M.lines.length > 1 ? TRACK_HEAD : 0;
      for (let j=lo;j<end;j++) if (detailed(line.units[j], px)) {
        const sp=chartSpans(line.units[j]);
        if (sp) depth=Math.max(depth,sp.maxDepth+1);
      }
      const l = {line, y0:y+heading, depth, heading}; y += heading+depth*ROWH+4; return [l];
    });
    const depths = asyncLanes(), n = depths.map((lanes) => Array.from({length:lanes.length}, (_, k) => lanes[k] || 1).reduce((a, b) => a + b, 0));
    const total = n.reduce((a, b) => a + b, 0);
    let lanes = null;
    if (total) {
      // A track per span name, as in Perfetto, each its name and its lanes, as tall as a row of the line above until
      // they would not fit on screen: then with many lanes each is a pixel, and they read as how many ran at once.
      const head = y + 6, used = n.filter((c) => c).length;
      const room = H - (head + ASYNC_HEAD + scrollY) - 12 - used * (TRACK_HEAD + 4);
      const h = clamp(Math.floor(room / total), 1, ROWH);
      const tracks = new Array(n.length).fill(null);
      let ty = head + ASYNC_HEAD - 6, base = 0;
      n.forEach((c, k) => {
        if (!c) return;
        let offset = 0;
        const offsets = Array.from({length:depths[k].length}, (_, lane) => { const at = offset; offset += depths[k][lane] || 1; return at; });
        tracks[k] = { name: X.TRACKS[k].name, head: ty, y0: ty + TRACK_HEAD, n: c, base, offsets };
        base += c;
        ty += TRACK_HEAD + c * h + 4;
      });
      lanes = { head, h, tracks, total };
      y = ty;
    }
    return { top, bottom: y + scrollY + 12, lines, lanes };
  }

  function paint() {
    if (S.view !== 'flame' || !M) return;
    const T = X.T;
    ctx.setTransform(...X.toView(X.fitCanvas(canvas, W, H, X.layerView(root, W, H))));
    ctx.clearRect(0, 0, W, H);
    if (S.flame === 'heavy' && (!M.heavy || M.heavy.sel !== S.sel)) mergeHeavy();
    sync();
    const x0 = LEFT, x1 = W - RIGHT, span = win.d1 - win.d0, scale = (x1 - x0) / span;
    const X_ = (d) => x0 + (d - win.d0) * scale;
    const top = X.contentTop() + AXIS;
    hot = { bars: [] };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, H - top);
    ctx.clip();
    ctx.font = `500 11px ${X.SANS}`;
    ctx.textBaseline = 'middle';
    if (S.flame === 'heavy') paintHeavy(top, X_, T);
    else {
      let L = layout();
      if (pendingFocus) {
        const {unit, row} = pendingFocus, line = M.pos.get(unit)?.line;
        const l = L.lines.find(l => l.line === line), sp = l && chartSpans(unit);
        if (sp && row < sp.flat.length / 5) {
          const fr = sp.flow.root[row];
          let y = l.y0 + sp.flow.depth[row] * ROWH;
          if (fr > 0) {
            const track = X.trackIndex.get(sp.names[sp.flat[fr * 5]]), lane = sp.flat[fr * 5 + 4] >>> 10;
            const tr = L.lanes?.tracks[track];
            if (tr) y = tr.y0 + (tr.offsets[lane] + sp.flow.depth[row]) * L.lanes.h;
          }
          scrollY = clamp(scrollY + y - (L.top + 6 + l.heading), 0, Math.max(0, L.bottom - H));
        }
        pendingFocus = null;
        L = layout();
      }
      if (scrollY > Math.max(0, L.bottom - H)) { scrollY = Math.max(0, L.bottom - H); L = layout(); }
      paintTime(L, X_, scale, T);
    }
    ctx.restore();
    paintAxis(top, X_, T);
  }

  // A tick label beside its tick, or before it at the right edge.
  function tickLabel(label, x, y) {
    const w = X.textWidth(label, 11, 400);
    ctx.fillText(label, x + 3 + w > W - 4 ? x - 3 - w : x + 3, y);
  }

  function paintAxis(top, X_, T) {
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, top - AXIS, W, AXIS);
    ctx.strokeStyle = T.line;
    ctx.beginPath(); ctx.moveTo(LEFT, top - 0.5); ctx.lineTo(W - RIGHT, top - 0.5); ctx.stroke();
    ctx.font = `400 11px ${X.SANS}`;
    ctx.fillStyle = T.muted;
    ctx.textBaseline = 'alphabetic';
    if (S.flame === 'heavy') {
      // Summed time of everything in view.
      const h = M.heavy;
      for (const { x, label } of durationTicks(h.total, X_)) {
        ctx.fillRect(Math.round(x), top - 5, 1, 5);
        tickLabel(label, x, top - 8);
      }
      // While spans still come in, over everything in view: said at the right, over the ticks it would cross.
      if (h && h.unit === null && h.units < h.all) {
        const note = `Loading spans: ${X.fmtInt(h.units)} of ${X.fmtInt(h.all)}`, nw = X.textWidth(note, 10.5, 400);
        ctx.fillStyle = T.bg;
        ctx.fillRect(W - RIGHT - nw - 12, top - 22, nw + 12, 16);
        ctx.fillStyle = T.muted;
        ctx.fillText(note, W - RIGHT - nw, top - 8);
      }
      return;
    }
    // Each run's title where it starts, or held at the left while it is in view, and the clock's ticks around them.
    const labels = X.runLabels(M.nav, win.d0, win.d1, W - LEFT - RIGHT);
    for (const { d, label } of X.clockTicks(M.nav, win.d0, win.d1, W - LEFT - RIGHT, labels)) {
      const x = X_(d);
      ctx.fillRect(Math.round(x), top - 5, 1, 5);
      tickLabel(label, x, top - 8);
    }
    ctx.font = `500 11px ${X.SANS}`;
    ctx.fillStyle = T.ink;
    for (const l of labels) ctx.fillText(l.text, LEFT + l.x, top - 8);
    // A folded idle stretch is only a break in the axis; where one run ends and the next begins, a line through it.
    for (const g of M.nav.gaps) {
      const x = X_((g.d0 + g.d1) / 2);
      if (x < LEFT || x > W - RIGHT) continue;
      breakMark(x, top - 0.5, T);
    }
    ctx.fillStyle = T.line;
    for (const d of M.nav.breaks) {
      const x = Math.round(X_(d));
      if (x >= LEFT && x <= W - RIGHT) ctx.fillRect(x, top - AXIS + 4, 1, AXIS - 4);
    }
  }

  // An axis break: two short slants across the axis line, nothing behind them.
  function breakMark(x, y, T) {
    ctx.strokeStyle = T.muted;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x - 4.5, y + 3); ctx.lineTo(x - 0.5, y - 3);
    ctx.moveTo(x + 0.5, y + 3); ctx.lineTo(x + 4.5, y - 3);
    ctx.stroke();
  }

  function paintTime(L, X_, scale, T) {
    const xL = LEFT, xR = W - RIGHT;
    // Where one run ends and the next begins, a line from the axis down.
    ctx.fillStyle = T.line;
    for (const d of M.nav.breaks) {
      const x = Math.round(X_(d));
      if (x >= xL && x <= xR) ctx.fillRect(x, L.top, 1, H - L.top);
    }
    // The asynchronous tracks below a rule, each under its span name.
    if (L.lanes) {
      ctx.fillStyle = T.grid;
      ctx.fillRect(xL, Math.round(L.lanes.head) - 0.5, xR - xL, 1);
      ctx.fillStyle = T.muted;
      ctx.font = `400 10.5px ${X.SANS}`;
      for (const tr of L.lanes.tracks) if (tr) ctx.fillText(tr.name, xL, tr.head + TRACK_HEAD / 2);
    }
    ctx.font = `500 11px ${X.SANS}`;
    flows = null;
    for (const l of L.lines) {
      if (l.heading && l.y0 >= L.top && l.y0 - l.heading < H) {
        ctx.fillStyle = T.muted;
        ctx.font = `400 10.5px ${X.SANS}`;
        ctx.fillText(`Concurrent lane ${l.line.number}`, xL, l.y0 - 4);
        ctx.font = `500 11px ${X.SANS}`;
      }
      paintLine(l, L.lanes, X_, scale, T, xL, xR);
    }
    paintFlows(T);
  }

  // Links of the selected compilation's spans, as Perfetto draws flows: an arrow from what a span waited for to it
  // (depends_on, end to end), or from what it followed to its start (follows_from).
  let flows = null;
  function paintFlows(T) {
    if (!flows) return;
    const { pos, links } = flows;
    ctx.save();
    ctx.strokeStyle = T.ink;
    ctx.fillStyle = T.ink;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.2;
    for (let k = 0; k < links.length; k += 3) {
      if (!links[k + 2]) continue;
      const a = pos.get(links[k]), b = pos.get(links[k + 1]);
      if (!a || !b) continue;
      const x1 = b.x1, y1 = b.y, x2 = links[k + 2] === 2 ? a.x0 : a.x1, y2 = a.y;
      arrow(x1, y1, x2, y2);
    }
    ctx.restore();
  }
  function arrow(x1, y1, x2, y2) {
    // Bulging right where the ends nearly line up, else an S from one to the other.
    const near = Math.abs(x2 - x1) < 24, d = near ? 18 : Math.max(10, (x2 - x1) / 2);
    const c1x = x1 + d, c2x = near ? x2 + d : x2 - d;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(c1x, y1, c2x, y2, x2, y2);
    ctx.stroke();
    // The curve arrives level, so the head points along it: right, or back left when it bulged past.
    const ang = x2 >= c2x ? 0 : Math.PI;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 6 * Math.cos(ang - 0.45), y2 - 6 * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - 6 * Math.cos(ang + 0.45), y2 - 6 * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  function paintLine(l, lanes, X_, scale, T, xL, xR) {
    const line = l.line;
    const top = X.contentTop()+AXIS;
    const [lo, end] = visible(line);
    // The last pixel drawn on each row, so spans thinner than a pixel draw once per pixel: a compilation a pixel
    // wide, then its depths, then its lanes.
    const lastPx = new Float64Array(1 + l.depth + (lanes ? lanes.total : 0)).fill(-1);
    const root = T.scheme === 'dark' ? '#4a505a' : '#a9b0ba';
    const dim = S.name !== null;
    const laneH = lanes ? lanes.h : 0, gapY = laneH >= 6 ? 1 : 0;
    // Pixel-wide compilations are many small rectangles: gathered per colour and filled as one path each.
    const batch = new Map();
    const rect = (color, x, y, w, h) => { let a = batch.get(color); if (!a) batch.set(color, a = []); a.push(x, y, w, h); };
    for (let j = lo; j < end; j++) {
      const i = line.units[j], a = X_(line.d0[j]), b = X_(line.d1[j]), w = b - a;
      const sel = i === S.sel;
      if (!detailed(i, scale)) {
        // A pixel-wide compilation: its biggest part at each of the first levels, and a mark on each of its lanes.
        const px = Math.floor(a);
        if (px === lastPx[0]) continue;
        lastPx[0] = px;
        const dom = dominantOf(i);
        for (let d = 0; d < dom.length && d < ROWS; d++) {
          rect(dom[d] === -2 ? root : dom[d] >= 0 ? T.cols[dom[d]] : T.unowned, px, l.y0 + d * ROWH, Math.max(1, w), ROWH - 1);
        }
        hot.bars.push({ i, x0: px, x1: px + Math.max(1, w), y0: l.y0, y1: l.y0 + dom.length * ROWH, r: -1 });
        if (lanes) {
          for (const [track, lane, depth, part] of dom.lanes) {
            const tr = lanes.tracks[track];
            if (tr && tr.offsets[lane] !== undefined) rect(part >= 0 ? T.cols[part] : T.unowned, px, tr.y0 + (tr.offsets[lane] + depth) * laneH, 1, laneH - gapY);
          }
        }
        if (sel) { ctx.strokeStyle = T.sel; ctx.lineWidth = 2; ctx.strokeRect(px - 1, l.y0 - 1, Math.max(2, w) + 2, ROWH + 1); }
        if (!X.hasSpans(i)) X.loadChunk(data.units[i].k).catch(() => {});
        continue;
      }
      const sp = chartSpans(i);
      // With a compilation selected the others recede, as in the Timeline.
      const fade = S.sel !== null && !sel ? 0.4 : 1;
      if (sel) {
        ctx.fillStyle = T.sel;
        ctx.globalAlpha = 0.07;
        ctx.fillRect(a - 2, l.y0 - 2, w + 4, (sp ? sp.maxDepth + 1 : ROWS) * ROWH + 3);
        ctx.globalAlpha = 1;
      }
      if (sp) {
        // Its links, once it is wide enough for them to read.
        if (sel && w > 60) flows = { pos: new Map(), links: sp.links };
        const s = {}, {flat:f,flow,names} = sp;
        for (const r of visibleRows(sp,l,a,scale)) {
          const fr=flow.root[r];
          s.start=f[r*5+2]/1000; s.dur=f[r*5+3]/1000; s.name=names[f[r*5]];
          s.part=sp.parts[r]; s.flowDepth=flow.depth[r]; s.depth=flow.depth[r]+Number(fr>0);
          s.lane=fr>0?f[fr*5+4]>>>10:-1; s.track=fr>0?X.trackIndex.get(names[f[fr*5]]):-1;
          const async = s.lane >= 0, tr = async && lanes ? lanes.tracks[s.track] : null;
          if (async && (!tr || tr.offsets[s.lane] === undefined)) continue;
          const sx = a + s.start * scale, ex = sx + s.dur * scale;
          if (ex < xL || sx > xR) continue;
          const flowRow = async ? tr.offsets[s.lane] + s.flowDepth : 0;
          const bw = ex - sx, row = async ? 1 + l.depth + tr.base + flowRow : 1 + s.depth;
          const y = async ? tr.y0 + flowRow * laneH : l.y0 + s.depth * ROWH, h = async ? laneH - gapY : ROWH - 1;
          if (y+h<top || y>H) continue;
          if (sel && flows) flows.pos.set(r, { x0: sx, x1: ex, y: y + h / 2 });
          if (bw < 1) { const px = Math.floor(sx); if (px === lastPx[row]) continue; lastPx[row] = px; }
          // Separate logical flows are hollow; ordinary descendants keep their nesting within that flow.
          const color = s.depth === 0 ? root : s.part >= 0 ? T.cols[s.part] : async ? T.faint : T.unowned;
          const hollow = async && bw >= 4 && h >= 5, fill = hollow ? X.mix(color, T.bg, 0.8) : color;
          ctx.globalAlpha = (dim && s.name !== S.name ? 0.3 : 1) * fade;
          ctx.fillStyle = fill;
          ctx.fillRect(sx, y, Math.max(1, bw - (bw > 3 ? 1 : 0)), h);
          if (hollow) { ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.strokeRect(sx + 0.6, y + 0.6, Math.max(1, bw - 2.2), h - 1.2); }
          if (bw > 26 && h >= 11) {
            let tx = Math.max(sx, xL) + 4;
            const label = s.depth === 0 ? `${data.units[i].l} · ${X.fmtMs(s.dur)}` : s.name;
            if (s.depth === 0 && Math.min(ex, xR) - tx > 40) {
              // The compilation's group, in its colour from the legend.
              ctx.fillStyle = T[X.sideKey(data.units[i].g)] || T.ink;
              ctx.beginPath(); ctx.arc(tx + 3, y + h / 2, 3, 0, Math.PI * 2); ctx.fill();
              tx += 10;
            }
            const room = Math.min(ex, xR) - tx - 3;
            const t = room > 14 ? X.fitText(label, 11, 500, room) : '';
            if (t) { ctx.fillStyle = X.inkOn(fill); ctx.fillText(t, tx, y + h / 2); }
          }
          ctx.globalAlpha = 1;
          if ((dim && s.name === S.name) || (spanHi && spanHi.unit === i && spanHi.row === r)) {
            ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5;
            ctx.strokeRect(sx + 0.75, y + 0.75, Math.max(1, bw - 1.5), h - 1.5);
          }
          hot.bars.push({ i, x0: sx, x1: ex, y0: y, y1: y + Math.max(h, 3), r });
        }
      } else {
        // Its parts from the summary, until its spans arrive.
        X.loadChunk(data.units[i].k).catch(() => {});
        const u = data.units[i];
        ctx.globalAlpha = fade;
        ctx.fillStyle = root;
        ctx.fillRect(a, l.y0, Math.max(1, w - 1), ROWH - 1);
        for (let k = 0; k < X.NC; k++) {
          const d = X.depthIdx[k] + 1;
          if (d >= ROWS) continue;
          const f = u.f[k];
          let pos = 0;
          ctx.fillStyle = T.cols[k];
          for (let q = 0; q < f.length; q += 2) {
            const fa = pos + f[q], fb = fa + f[q + 1];
            pos = fb;
            ctx.fillRect(a + fa / X.GRID * w, l.y0 + d * ROWH, Math.max(1, (fb - fa) / X.GRID * w - 1), ROWH - 1);
          }
        }
        hot.bars.push({ i, x0: a, x1: b, y0: l.y0, y1: l.y0 + ROWS * ROWH, r: -1 });
        ctx.globalAlpha = 1;
      }
      if (sel) { ctx.strokeStyle = T.sel; ctx.lineWidth = 2; ctx.strokeRect(a - 1, l.y0 - 1, w + 2, ROWH + 1); }
    }
    ctx.globalAlpha = S.sel !== null ? 0.4 : 1;
    for (const [color, a] of batch) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < a.length; k += 4) ctx.rect(a[k], a[k + 1], a[k + 2], a[k + 3]);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Ticks of a duration axis over the window, for a chart whose full width is `total` ms.
  function durationTicks(total, X_) {
    const span = (win.d1 - win.d0) * total, step = X.niceStep(Math.max(span, 1e-6), Math.max(2, (W - LEFT - RIGHT) / 110)), out = [];
    for (let t = Math.ceil(win.d0 * total / step) * step; t <= win.d1 * total; t += step) {
      out.push({ x: X_(t / total), label: t === 0 ? '0' : step >= 1000 ? `${X.round3(t / 1000)} s` : X.fmtSpan(t, step) });
    }
    return out;
  }

  function paintHeavy(top, X_, T) {
    heavyBlock(M.heavy.sync, M.heavy.tracks, top + 8 - scrollY, X_, T);
  }

  // The compiler's chart and, below a rule, each asynchronous track's, in the flame chart's order; returns where
  // they end.
  function heavyBlock(sync, tracks, y0, X_, T) {
    const rows = Math.max(1, sync.maxDepth + 1);
    heavyRows(sync.rects, rows, y0, X_, T);
    let y = y0 + rows * ROWH;
    const shown = tracks.filter((t) => t.rects.length);
    if (shown.length) {
      ctx.fillStyle = T.grid;
      ctx.fillRect(LEFT, Math.round(y + 6) - 0.5, W - LEFT - RIGHT, 1);
      y += 12;
      for (const t of shown) {
        const r = t.maxDepth + 1;
        heavyRows(t.rects, r, y, X_, T);
        y += r * ROWH + 4;
      }
    }
    return y;
  }

  function heavyRows(list, rows, y0, X_, T) {
    const xL = LEFT, xR = W - RIGHT, h = M.heavy;
    ctx.font = `500 11px ${X.SANS}`;
    const lastAt = new Float64Array(rows).fill(-1);
    for (const rc of list) {
      if (rc.depth >= rows) continue;
      const sx = X_(rc.x0), ex = X_(rc.x1);
      if (ex < xL || sx > xR) continue;
      const bw = ex - sx;
      if (bw < 1) { const px = Math.floor(sx); if (px === lastAt[rc.depth]) continue; lastAt[rc.depth] = px; }
      const y = y0 + rc.depth * ROWH;
      if (y + ROWH < X.contentTop() + AXIS || y > H) continue;
      const node = rc.node, color = heavyColor(node, T);
      // Asynchronous spans hollow, as in the flame chart.
      const hollow = node.async && bw >= 4, fill = hollow ? X.mix(color, T.bg, 0.8) : color;
      ctx.globalAlpha = S.name !== null && S.name !== h.focus && node.name !== S.name ? 0.3 : 1;
      ctx.fillStyle = fill;
      ctx.fillRect(sx, y, Math.max(1, bw - (bw > 3 ? 1 : 0)), ROWH - 1);
      if (hollow) { ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.strokeRect(sx + 0.6, y + 0.6, Math.max(1, bw - 2.2), ROWH - 2.2); }
      // The top bar is all the compilations merged, or the selected one: named as by time. A track's top bar too narrow
      // for its name has it after the bar.
      const label = node.depth === 0 && !node.async && !h.focus
        ? (h.unit !== null ? `${data.units[h.unit].l} · ${X.fmtMs(h.total)}` : `${X.nUnits(h.units)} · ${X.fmtMs(h.total)}`)
        : node.name;
      const tx = Math.max(sx, xL) + 4, room = Math.min(ex, xR) - tx - 3;
      if (node.async && node.depth === 0 && X.textWidth(label, 11, 500) > room) {
        ctx.fillStyle = T.muted;
        ctx.fillText(label, Math.max(ex, xL) + 6, y + ROWH / 2);
      } else if (bw > 26) {
        const t = room > 14 ? X.fitText(label, 11, 500, room) : '';
        if (t) { ctx.fillStyle = X.inkOn(fill); ctx.fillText(t, tx, y + ROWH / 2); }
      }
      ctx.globalAlpha = 1;
      hot.bars.push({ heavy: rc, x0: sx, x1: ex, y0: y, y1: y + ROWH });
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Pointer and keys.

  function barAt(px, py) {
    if (!hot) return null;
    for (let k = hot.bars.length - 1; k >= 0; k--) {
      const b = hot.bars[k];
      if (py >= b.y0 && py < b.y1 && px >= b.x0 - 0.5 && px <= Math.max(b.x1, b.x0 + 1) + 0.5) return b;
    }
    return null;
  }

  function tipFor(b) {
    if (b.heavy) {
      const node = b.heavy.node, k = b.heavy.k, h = M.heavy, root = node.depth === 0 && !node.async, part = node.part >= 0 ? data.columns[node.part].label : '';
      const who = h.unit !== null ? data.units[h.unit].l : null, dur = h.dur(k), n = h.n(k);
      const lines = [root && !h.focus ? who || 'All in view' : node.name, `${X.fmtMs(dur)} · ${X.fmtPct(dur / h.total)}${who ? ` of ${who}` : ''}`];
      lines.push(node.async ? 'Separate logical flow; overlapping occurrences add up' : `self ${X.fmtMs(Math.max(0, dur - h.inner(k)))}`);
      // How often it runs: spans on this path, and per compilation.
      lines.push(h.units > 1 ? `${X.fmtInt(n)} spans, ${X.round3(n / h.units)} per ${X.UNIT} · ${X.fmtMs(dur / h.units)} each` : `${X.fmtInt(n)} ${n === 1 ? 'span' : 'spans'}`);
      if (h.focus) {
        lines.push(`${h.direction === 'callers' ? 'Callers of' : 'Callees of'} ${h.focus}`);
        if (h.origins.length && root) lines.push(`Flow started by ${h.origins.join(', ')}`);
      }
      lines.push(part);
      return lines;
    }
    const u = data.units[b.i];
    if (b.r < 0) return [u.l, X.groupName(u.g), `${X.UNIT} ${X.fmtMs(u.ms)}`];
    const s = X.spansOf(b.i).rows[b.r];
    const lines = [s.name, `${X.fmtMs(s.dur)} · from ${X.fmtMs(s.start)} into ${u.l}`];
    if (s.part >= 0) lines.push(data.columns[s.part].label);
    if (s.lane >= 0) lines.push(s.flowStart ? 'Starts a separate logical flow' : 'Within a separate logical flow');
    return lines;
  }

  let drag = null;
  const clicks = [];
  function down(e, px, py) {
    drag = { x: px, y: py, moved: false, sy: scrollY, bar:barAt(px, py) };
  }
  function move(e, px, py) {
    if (drag && (e.buttons & 1)) {
      const dx = px - drag.x, dy = py - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        pan(-dx);
        drag.x = px;
        scrollTo(drag.sy - dy);
        X.hideTip();
        return;
      }
    }
    const b = barAt(px, py);
    root.classList.toggle('on-bar', !!b);
    if (b) X.tip(tipFor(b), px, py); else X.hideTip();
  }
  function up(e, px, py) {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    const b = d.bar;
    clicks.push({bar:b, x:px, y:py, time:e.timeStamp});
    if (clicks.length > 2) clicks.shift();
    // In the flame graph a bar picks its name, as the table does; in the flame chart it selects its compilation.
    // Empty space lets both go.
    if (b && b.heavy) {
      if (b.heavy.node.name) X.spans.pick(S.name === b.heavy.node.name ? null : b.heavy.node.name);
    } else if (b) {
      X.select(b.i, { keepWindow: true });
      if (b.r >= 0) { spanHi = { unit: b.i, row: b.r }; X.panelShowSpan(b.i, b.r); }
      request();
    } else if (py > X.contentTop() + AXIS) {
      X.select(null, { keepWindow: true });
      if (S.name !== null) X.spans.pick(null);
    }
  }
  function dbl(e, px, py) {
    // The first click can change selection controls or finish loading a stack.
    // Zoom the bar originally pressed, even if its screen position has changed.
    const first = clicks.length === 2 && clicks[0];
    const b = first && e.timeStamp - first.time < 1500 && Math.hypot(px-first.x, py-first.y) < 5
      ? first.bar : barAt(px, py);
    if (!b) return;
    if (b.heavy) { setWindow(b.heavy.x0 - (b.heavy.x1 - b.heavy.x0) * 0.03, b.heavy.x1 + (b.heavy.x1 - b.heavy.x0) * 0.03, true); return; }
    X.select(b.i, {keepWindow:true});
    zoomToSpan(b.i, Math.max(0, b.r));
  }
  function zoomToSpan(unit, row) {
    model();
    if (S.flame !== 'time' || !M.pos.has(unit)) return;
    const raw = X.rawSpans(unit);
    if (!raw || row < 0 || row >= raw.flat.length / 5) return;
    const a = M.nav.start[unit] + raw.flat[row * 5 + 2] / 1000, duration = raw.flat[row * 5 + 3] / 1000;
    spanHi = {unit, row};
    X.nav.set(a - duration * .05, a + duration * 1.05, {animate:true, push:true, focus:{unit, row}});
  }
  function wheel(e, px) {
    const scale = e.deltaMode === 1 ? ROWH : e.deltaMode === 2 ? Math.max(1, H - X.contentTop() - AXIS) : 1;
    const dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (e.ctrlKey || e.metaKey) { zoomAt(px, Math.exp(dy * 0.004)); return true; }
    if (Math.abs(dx) > Math.abs(dy) || e.shiftKey) { pan(e.shiftKey ? dy : dx); return true; }
    scrollTo(scrollY + dy);
    X.hideTip();
    return true;
  }
  function heavyBottom() {
    const h=M.heavy;
    return X.contentTop()+AXIS+8+(h.sync.maxDepth+1)*ROWH+12+
      h.tracks.filter(t=>t.rects.length).reduce((sum,t)=>sum+(t.maxDepth+1)*ROWH+4,0);
  }
  function scrollTo(y) {
    const bottom = S.flame === 'time' ? layout().bottom : heavyBottom();
    const max = Math.max(0, bottom - H);
    const v = clamp(y, 0, max);
    if (v !== scrollY) { scrollY = v; request(); }
  }
  function key(e) {
    if (!M) return false;
    const k = e.key.toLowerCase();
    if (k === 'w') zoomAt(W / 2, 0.8);
    else if (k === 's') zoomAt(W / 2, 1.25);
    else if (k === 'a') pan(-(W - LEFT - RIGHT) * 0.15);
    else if (k === 'd') pan((W - LEFT - RIGHT) * 0.15);
    else if (k === 'f') fit(true);
    else return false;
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------

  function render() {
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return;
    canvas.setAttribute('aria-label', focused() ? `${S.prof === 'callers' ? 'Callers' : 'Callees'} of ${S.profileRoot}` : S.flame === 'heavy' ? 'Flame graph' : 'Flame chart');
    model();
    if (S.flame === 'heavy' && M.heavy && M.heavy.sel !== S.sel) M.heavy = null;
    fitHeavy();
    request();
  }
  // Left heavy shows the merged chart where it was left, or all of it once the filters change what it merges.
  function fitHeavy() {
    if (S.flame !== 'heavy' || !M || heavyWin.key === M.key) return;
    heavyWin = { d0: 0, d1: heavyExtent(), key: M.key };
    heavyBack = []; scrollY = 0;
    X.nav.draw();
  }

  X.flame = {
    init, render, move, down, up, dbl, wheel, key,
    back() {
      if (S.flame !== 'heavy' || !heavyBack.length) return false;
      setWindow(...heavyBack.pop(),true,false);return true;
    },
    profileModel() { model();if(!M.heavy || M.heavy.sel!==S.sel)mergeHeavy();return M.heavy; },
    leave() { X.hideTip(); },
    // The window follows a selection through X.nav; left heavy merges again with it under the rest.
    selectionChanged(keepWindow) {
      spanHi = null;
      if (!keepWindow && S.sel !== null) pendingFocus = {unit:S.sel, row:0};
      if (S.flame === 'heavy') { scrollY = 0; heavyBack = []; }
      if (M) M.heavy = null;
      if (S.view === 'flame') request();
    },
    modeChanged() { scrollY = 0; fitHeavy(); request(); },
    // For the overview strip in left heavy.
    drawMini, heavyExtent,
    heavyWindow() { return [heavyWin.d0, heavyWin.d1]; },
    setHeavyWindow(d0, d1, animate) { setWindow(d0, d1, animate); },
    highlightSpan(unit, row) { spanHi = unit === null ? null : { unit, row }; request(); },
    zoomToSpan,
    invalidate() { M = null; },
    // Spans count toward other columns now: their colours, merged again.
    layoutChanged() { dominant.clear(); chartCache.clear(); M = null; if (S.view === 'flame') request(); },
  };
})();
