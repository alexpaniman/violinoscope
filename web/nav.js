// Navigation in time, shared by the Timeline's two modes, the flame chart and the waterfall: the compilations in view
// laid out where they ran, run after run, each run on its own clock with long idle stretches folded; the stretch of
// it on screen (S.tw, in display time); and the overview strip that shows and moves it. Zooming or panning either
// mode moves it for both. It never changes which compilations are in view: that is the filters' job. In the
// Profile's flame graph the strip stays, showing the merged chart in miniature and moving that chart's own zoom.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, clamp } = X;
  const STRIP = 40;

  let M = null, canvas, anim = 0, drawn = 0;
  // Where the time views were before each jump in.
  const back = [];

  X.nav = {};
  const shown = X.nav.shown = () => S.view === 'timeline' || S.view === 'flame';
  const heavy = () => S.view === 'flame' && S.flame === 'heavy';
  // What the strip spans and shows, and moving it: time, or the merged chart in left heavy.
  const range = () => (heavy() ? [0, X.flame.heavyExtent()] : all());
  const current = () => (heavy() ? X.flame.heavyWindow() : X.nav.win());
  const move = (a, b, opts) => (heavy() ? X.flame.setHeavyWindow(a, b, opts && opts.animate) : X.nav.set(a, b, opts));
  X.nav.height = () => (shown() ? STRIP + 12 : 0);

  // The compilations in view, run by run in the order they ran, and where each starts in display time (start[i]).
  // A new set starts on all of it, or on the selected compilation.
  const model = X.nav.model = () => {
    const viewKey = X.viewKey(), key = `${viewKey}|${X.chunksLoaded()}`;
    if (M && M.key === key) return M;
    const units = X.allInView().sort((a, b) => X.runOf(a) - X.runOf(b) || data.units[a].at - data.units[b].at);
    const fold = X.timeFold(units), pos = new Map(), start = new Float64Array(data.units.length).fill(NaN);
    let dMin = Infinity, dMax = -Infinity, run = null;
    units.forEach((i, k) => {
      if (!run || run.run !== X.runOf(i)) run = fold.runs.find((r) => r.run === X.runOf(i));
      const d = start[i] = fold.start ? fold.start[i] : run.toD(data.units[i].at);
      pos.set(i, k);
      const [lo, hi] = X.spanExtent(i);
      dMin = Math.min(dMin, d + lo);
      dMax = Math.max(dMax, d + hi);
    });
    if (!units.length) { dMin = 0; dMax = 1; }
    const previous = M;
    M = { key, viewKey, units, pos, start, runs: fold.runs, gaps: fold.gaps, breaks: fold.breaks, dMin, dMax };
    if (previous && previous.viewKey === viewKey) {
      // Newly loaded tails can change both the bounds and folded gaps. Keep a zoom on the same real times;
      // a view showing everything follows the expanded bounds instead.
      const remap = (w) => w.map((d) => {
        const oldRun = previous.runs.findLast((r) => r.d0 <= d) || previous.runs[0];
        const newRun = oldRun && M.runs.find((r) => r.run === oldRun.run);
        return newRun ? newRun.toD(oldRun.toR(d)) : d;
      });
      if (S.tw) S.tw = S.tw[0] <= previous.dMin && S.tw[1] >= previous.dMax ? null : remap(S.tw);
      for (let k = 0; k < back.length; k++) back[k] = remap(back[k]);
    } else {
      back.length = 0;
      S.tw = S.sel !== null && pos.has(S.sel) ? extent(S.sel) : null;
    }
    return M;
  };

  function all() {
    const m = model(), pad = (m.dMax - m.dMin) * 0.005 || 1;
    return [m.dMin - pad, m.dMax + pad];
  }
  // A compilation's stretch, its asynchronous tail included.
  function extent(i) {
    const [lo, hi] = X.spanExtent(i), a = M.start[i] + lo, b = M.start[i] + hi;
    const pad = (b - a) * 0.04;
    return [a - pad, b + pad];
  }

  X.nav.win = () => { model(); if (!S.tw) S.tw = all(); return S.tw; };

  // Show d0..d1, gliding there when asked to: the width in log space so a zoom feels even. `unit` tells the views
  // whose stretch it is, so the Timeline can bring its rows up.
  // A jump (opts.push: a double-click, a compilation picked, F) remembers where it left, so Back or Esc returns there.
  // While gliding, the views hear `animating`, and settle only at the end.
  X.nav.set = (d0, d1, opts) => {
    const m = model(), whole = m.dMax - m.dMin || 1;
    const span = clamp(d1 - d0, Math.max(whole * 1e-8, 1e-4), whole * 1.05);
    const a = clamp(d0, m.dMin - whole * 0.025, m.dMax + whole * 0.025 - span), to = [a, a + span];
    cancelAnimationFrame(anim);
    const from = S.tw;
    if (opts && opts.push && from && (Math.abs(from[0] - to[0]) > span * 1e-3 || Math.abs(from[1] - to[1]) > span * 1e-3)) {
      back.push(from.slice());
      if (back.length > 40) back.shift();
    }
    if (!(opts && opts.animate) || !from) { S.tw = to; changed(opts); return; }
    const start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / 220), e = 1 - Math.pow(1 - k, 3);
      const wa = from[1] - from[0], wb = to[1] - to[0], w = Math.exp(Math.log(wa) + (Math.log(wb) - Math.log(wa)) * e);
      const ca = (from[0] + from[1]) / 2, cb = (to[0] + to[1]) / 2, c = ca + (cb - ca) * e;
      S.tw = k < 1 ? [c - w / 2, c + w / 2] : to;
      changed(k < 1 ? { animating: true } : opts);
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };
  function changed(opts) {
    X.emit('window', opts || {});
    if (!drawn) drawn = requestAnimationFrame(() => { drawn = 0; draw(); });
  }

  X.nav.showUnit = (i) => { model(); if (M.pos.has(i)) { const [a, b] = extent(i); X.nav.set(a, b, { animate: true, unit: i, push: true }); } };
  X.nav.fitAll = () => { const [a, b] = all(); X.nav.set(a, b, { animate: true, push: true }); };
  // Back to where the time views were before the last jump; false when there is nowhere to go back to.
  const timeView = () => S.view === 'timeline' || (S.view === 'flame' && S.flame === 'time');
  X.nav.back = () => {
    if (!timeView() || !back.length) return false;
    const w = back.pop();
    X.nav.set(w[0], w[1], { animate: true });
    return true;
  };

  // ---------------------------------------------------------------------------------------------------------
  // The strip: every compilation where it ran, one after another down it in its group's colour, a line where one
  // run ends and the next begins, the selected one marked, and the stretch on screen left clear.

  function place() {
    const el = $('overview');
    el.hidden = !shown();
    if (el.hidden) return;
    const c = $('controls');
    el.style.top = `${c.offsetTop + c.offsetHeight + 12}px`;
    draw();
  }
  X.nav.place = place;

  function draw() {
    if (!shown()) return;
    const T = X.T, w = canvas.clientWidth, h = STRIP, vv = window.visualViewport;
    if (!w) return;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(...X.toView(X.fitCanvas(canvas, w, h, { x: 0, y: 0, w, h, s: (window.devicePixelRatio || 1) * (vv ? clamp(vv.scale, 1, 4) : 1) })));
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = T.raised;
    ctx.beginPath(); ctx.roundRect(0, 0, w, h, 6); ctx.fill();
    const [a0, b0] = range(), xOf = (d) => (d - a0) / (b0 - a0) * w;
    if (heavy()) X.flame.drawMini(ctx, w, h, T);
    else {
      const m = model(), n = m.units.length;
      ctx.fillStyle = T.line;
      for (const d of m.breaks) ctx.fillRect(Math.round(xOf(d)), 0, 1, h);
      m.units.forEach((i, k) => {
        const u = data.units[i];
        ctx.fillStyle = T[X.sideKey(u.g)] || T.ink;
        ctx.fillRect(xOf(m.start[i]), 3 + k / Math.max(1, n - 1) * (h - 8), Math.max(1, u.ms / (b0 - a0) * w), 2);
      });
      if (S.sel !== null && m.pos.has(S.sel)) {
        ctx.fillStyle = T.sel;
        ctx.fillRect(Math.round(xOf(m.start[S.sel])), 0, 1.5, h);
      }
    }
    const [d0, d1] = current(), a = xOf(d0), b = xOf(d1);
    // All, while zoomed in on time; Esc goes back to where it was before.
    const zoomed = !heavy() && (a > 0.5 || b < w - 0.5);
    $('ov-nav').hidden = !zoomed;
    ctx.fillStyle = T.bg;
    ctx.globalAlpha = 0.62;
    ctx.fillRect(0, 0, Math.max(0, a), h);
    ctx.fillRect(b, 0, Math.max(0, w - b), h);
    ctx.globalAlpha = 1;
    if (a > 0.5 || b < w - 0.5) {
      ctx.strokeStyle = T.ink;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.max(0, a) + 0.75, 0.75, Math.max(1.5, Math.min(w, b) - Math.max(0, a) - 1.5), h - 1.5);
    }
  }
  X.nav.draw = draw;

  X.nav.init = () => {
    canvas = $('overview-canvas');
    let drag = null;
    const at = (e) => {
      const r = canvas.getBoundingClientRect(), [a0, b0] = range();
      return { d: a0 + clamp((e.clientX - r.left) / r.width, 0, 1) * (b0 - a0), px: (b0 - a0) / r.width };
    };
    // Dragging picks a new stretch, as in other tools; while zoomed in, dragging an edge of the stretch moves it.
    canvas.addEventListener('pointerdown', (e) => {
      const [a0, b0] = range(), p = at(e), w = current(), near = 6 * p.px, whole = w[0] <= a0 + p.px && w[1] >= b0 - p.px;
      const which = whole ? 'new' : Math.abs(p.d - w[0]) <= near ? 'a' : Math.abs(p.d - w[1]) <= near ? 'b' : 'new';
      drag = { which, d: p.d, win: w.slice() };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = at(e), dd = p.d - drag.d;
      if (drag.which === 'a') move(Math.min(p.d, drag.win[1] - p.px), drag.win[1]);
      else if (drag.which === 'b') move(drag.win[0], Math.max(p.d, drag.win[0] + p.px));
      else if (Math.abs(dd) > 2 * p.px) move(Math.min(drag.d, p.d), Math.max(drag.d, p.d));
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('dblclick', () => { if (heavy()) X.flame.setHeavyWindow(0, X.flame.heavyExtent(), true); else X.nav.fitAll(); });
    $('ov-nav').addEventListener('click', (e) => { if (e.target.closest('[data-nav]')) X.nav.fitAll(); });
    X.on('chunk', () => { if (shown()) { model(); changed(); } });
  };
})();
