// The page: the control rows, the filters (the legend and the compile-time range), selection, what-if, finding a
// compilation by pasting its id, the keyboard sheet, and routing of the pointer and keys to the view on screen.
//
// Three things, each with one meaning everywhere. The filters choose which compilations every view shows. The time
// views share where in time they look (X.nav). The selected compilation is only ever highlighted, never shown
// alone; a filter that leaves it out clears it.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data, meta = X.meta, R = X.R;
  const { $, esc, clamp, n1 } = X;

  // ---------------------------------------------------------------------------------------------------------
  // Small shared pieces: scheduling, the tooltip, where content starts.

  const pending = new Map();
  X.schedule = (fn) => {
    if (pending.has(fn)) return;
    pending.set(fn, requestAnimationFrame(() => { pending.delete(fn); fn(); }));
  };

  // The tooltip: lines of text, the first in bold, or markup of its own (tipHtml) for the compact ones.
  const TIP_LINES = '<div class="t1"></div><div class="k"></div><div></div><div class="k"></div><div class="k"></div>';
  let tipLines = null, tipHtml = '';
  X.tip = (lines, x, y) => {
    const tip = $('tip');
    if (tipHtml) { tip.innerHTML = TIP_LINES; tipHtml = ''; tipLines = null; }
    if (!tipLines) tipLines = [...tip.children];
    for (let k = 0; k < tipLines.length; k++) {
      const s = lines[k] || '';
      if (tipLines[k].textContent !== s) tipLines[k].textContent = s;
      tipLines[k].hidden = !s;
    }
    placeTip(x, y);
  };
  X.tipHtml = (html, x, y) => {
    const tip = $('tip');
    if (html !== tipHtml) { tip.innerHTML = html; tipHtml = html; tipLines = null; }
    placeTip(x, y);
  };
  function placeTip(x, y) {
    const tip = $('tip'), stage = $('stage');
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = x + 14 + w > stage.clientWidth - 8 ? x - 14 - w : x + 14, top = y + 14 + h > stage.clientHeight - 8 ? y - 14 - h : y + 14;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };
  X.hideTip = () => { $('tip').hidden = true; };

  // The views start below the controls, and below the time strip in the views that have it.
  X.contentTop = () => {
    const controls = $('controls');
    return controls.offsetTop + controls.offsetHeight + 12 + X.nav.height();
  };

  // ---------------------------------------------------------------------------------------------------------
  // Rendering.

  X.render = (opts) => {
    X.tokens();
    renderLegend();
    renderChip();
    renderNameChip();
    syncControls();
    X.nav.place();
    if (S.view === 'violins') X.violins.render(opts);
    else if (S.view === 'flame') X.flame.render(opts);
    else if (S.view === 'timeline') X.timeline.render();
    else X.spans.render();
    if (!$('rangecard').hidden) { placeCard(); renderCard(); }
  };

  // A tab, and a mode of it. Violins; the Timeline, where things ran: its flame chart or its waterfall; the Profile,
  // where the time goes, merged: its table, its flame graph, and, while a span is picked, its callers and callees.
  // The flame chart and the flame graph are the flame view's two modes, the table and callers and callees the spans
  // view's.
  X.go = (tab, mode) => {
    if (mode === 'callers' && S.name === null) mode = 'table';
    if (mode && tab === 'timeline') S.tl = mode;
    if (mode && tab === 'profile') S.prof = mode;
    S.tab = tab;
    const flame = S.flame, spans = S.spansMode;
    if (tab === 'violins') S.view = 'violins';
    else if (tab === 'timeline' && S.tl === 'waterfall') S.view = 'timeline';
    else if (tab === 'timeline') { S.view = 'flame'; S.flame = 'time'; }
    else if (S.prof === 'flame') { S.view = 'flame'; S.flame = 'heavy'; }
    else { S.view = 'spans'; S.spansMode = S.prof; }
    for (const id of ['violins', 'timeline', 'flame', 'spans']) $(id).hidden = id !== S.view;
    if (S.view !== 'violins') X.violins.closeMenu();
    if (S.flame !== flame) X.flame.modeChanged();
    if (S.spansMode !== spans) X.spans.invalidate();
    X.hideTip();
    if (S.view !== 'violins') X.panel.closeCard();
    X.render();
  };

  function syncControls() {
    const press = (sel, on) => document.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(on(b.dataset))));
    press('#views button', (d) => d.tab === S.tab);
    press('#modes button', (d) => d.mode === S.mode);
    press('#scales button', (d) => (d.linear === 'true') === S.linear);
    press('#tl-modes button', (d) => d.tl === S.tl);
    press('#prof-modes button', (d) => d.prof === S.prof);
    document.querySelector('#prof-modes [data-prof="callers"]').hidden = S.name === null;
    press('#table-modes button', (d) => (d.tree === 'true') === S.tableTree);
    const curved = document.querySelector('#scales [data-linear="false"]');
    curved.textContent = S.mode === 'share' ? 'Square root' : 'Log';
    curved.title = S.mode === 'share' ? 'Square root: spreads out the small shares, and still shows 0% (L)' : 'Logarithmic (L)';
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== S.tab || (!!el.dataset.forProf && el.dataset.forProf !== S.prof); });
  }

  // The span picked, wherever it was picked: shown in every tab, as a selected compilation is.
  function renderNameChip() {
    $('name-chip').hidden = S.name === null;
    if (S.name === null) return;
    const html = `<i class="span-glyph"></i><b>${esc(S.name)}</b>`;
    if ($('name-text').innerHTML !== html) $('name-text').innerHTML = html;
    $('name-text').title = `${S.name}: picked, and marked in the table, the flame graph and the Timeline; click for its callers and callees`;
    syncControls();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Selection and what-if.

  // Selecting highlights a compilation everywhere and shows its stretch in the time views, unless it was picked in
  // one (keepWindow); clearing keeps the stretch.
  X.select = (unit, opts) => {
    if (unit === S.sel) return;
    S.sel = unit;
    const show = () => { if (S.sel === unit && unit !== null && !(opts && opts.keepWindow)) X.nav.showUnit(unit); };
    if (unit !== null && !X.hasSpans(unit)) X.loadChunk(data.units[unit].k).then(show, () => {}); else show();
    X.panel.render();
    X.violins.drawHover();
    X.flame.selectionChanged();
    X.spans.invalidate();
    if (S.view === 'spans') X.spans.render();
    X.timeline.selectionChanged(opts && opts.keepWindow);
    X.nav.draw();
    if (!$('rangecard').hidden) renderCard();
  };
  // A selection the filters leave out is cleared.
  const dropHidden = () => {
    if (S.sel === null) return;
    const u = data.units[S.sel];
    if (!X.included(u.g) || (S.range && (u.ms < S.range[0] || u.ms > S.range[1]))) X.select(null);
  };

  // What is changed, so it is plain the page is showing a what-if; the dashed outlines are as measured. A factor on a
  // violin not shown waits until it is shown again.
  function renderWhatif() {
    const changed = [...S.factors].filter(([k, v]) => v !== 1 && data.columnIndex.has(k));
    $('whatif-chip').hidden = !changed.length;
    const named = changed.map(([id, v]) => `${data.columns[data.columnIndex.get(id)].label} ${X.fmtFactor(v)}`);
    $('whatif-text').innerHTML = `What if: <b>${changed.length === 1 ? esc(named[0]) : `${changed.length} violins`}</b>`;
    $('whatif-text').title = `What if: ${named.join(', ')}\nDashed outlines: every violin as measured`;
  }
  X.setFactor = (id, f) => {
    if (f === 1) S.factors.delete(id); else S.factors.set(id, f);
    X.project();
    renderWhatif();
    X.violins.invalidate();
    X.render();
    X.panel.renderCard();
    X.panel.render();
  };

  // ---------------------------------------------------------------------------------------------------------
  // Legend: every group in the same place, with its mark and how many of its compilations the compile-time range
  // keeps, so nothing moves when one changes. Violins: a click moves a group on, from the left half to the right,
  // to single queries (small groups only), to hidden. Elsewhere a group is in or out; a click switches it.

  X.glyph = (kind, color, title) => {
    const t = title ? `<title>${esc(title)}</title>` : '';
    const svg = (inner) => `<svg width="12" height="12" viewBox="0 0 12 12"${title ? ' role="img"' : ' aria-hidden="true"'}>${t}${inner}</svg>`;
    if (kind === 'left') return svg(`<path d="M6 1.5A4.5 4.5 0 0 0 6 10.5Z" fill="${color}"/><path d="M6 1.5A4.5 4.5 0 0 1 6 10.5" fill="none" stroke="${color}" stroke-opacity="0.35"/>`);
    if (kind === 'right') return svg(`<path d="M6 1.5A4.5 4.5 0 0 1 6 10.5Z" fill="${color}"/><path d="M6 1.5A4.5 4.5 0 0 0 6 10.5" fill="none" stroke="${color}" stroke-opacity="0.35"/>`);
    if (kind === 'ghost') return svg(`<circle cx="6" cy="6" r="4.5" fill="none" stroke="${color}" stroke-dasharray="2 2"/>`);
    if (kind === 'off') return svg(`<circle cx="6" cy="6" r="4" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="1.5 1.5"/>`);
    return svg(`<path d="M6 1.6L10.4 6L6 10.4L1.6 6Z" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`);
  };
  const glyph = X.glyph;
  const kindOf = (g) => (S.side[g] === 'left' || S.side[g] === 'right' ? S.side[g] : 'marker');
  // The runs a group's compilations come from, for its tooltip.
  let runsOf = null;
  function runsTitle(g) {
    if (!runsOf) {
      runsOf = new Map();
      data.units.forEach((u, i) => { if (!runsOf.has(u.g)) runsOf.set(u.g, new Set()); runsOf.get(u.g).add(X.runOf(i)); });
    }
    const runs = [...(runsOf.get(g) || [])].sort((a, b) => a - b).map(X.runTitle);
    return runs.length === 1 ? `Run: ${runs[0]}` : `Runs:\n${runs.join('\n')}`;
  }

  const SIDE_NAMES = { left: 'Left half', right: 'Right half', marker: 'Single queries', off: 'Hidden' };
  const MARKERS_UP_TO = 25;
  function nextSide(g) {
    const order = ['left', 'right', ...(data.groups.find((x) => x.id === g).units.length <= MARKERS_UP_TO ? ['marker'] : []), 'off'];
    return order[(order.indexOf(S.side[g]) + 1) % order.length];
  }

  function renderLegend() {
    const T = X.T, parts = [], counts = new Map(), r = S.range;
    for (const u of data.units) if (!r || (u.ms >= r[0] && u.ms <= r[1])) counts.set(u.g, (counts.get(u.g) || 0) + 1);
    const item = (g, attrs, mark, off, title) => `<button class="lg${off ? ' off' : ''}" type="button" ${attrs} title="${esc(`${title}\n${runsTitle(g.id)}`)}">`
      + `${mark}<span class="name">${esc(X.groupName(g.id))}</span><span class="n">${X.fmtInt(counts.get(g.id) || 0)}</span></button>`;
    if (S.view === 'violins') {
      for (const g of data.groups) {
        const kind = S.side[g.id], color = kind === 'off' ? T.faint : T[kind === 'marker' ? `m${X.slotOf(g.id)}` : kind];
        parts.push(item(g, `data-g="${esc(g.id)}"`, glyph(kind, color), kind === 'off', `${SIDE_NAMES[kind]}; click for ${SIDE_NAMES[nextSide(g.id)].toLowerCase()}`));
      }
    } else {
      for (const g of data.groups) {
        const on = X.included(g.id);
        parts.push(item(g, `data-include="${esc(g.id)}" aria-pressed="${on}"`, on ? glyph(kindOf(g.id), T[X.sideKey(g.id)]) : glyph('off', T.faint), !on,
          on ? 'Shown; click to leave it out' : 'Left out; click to show it'));
      }
    }
    const html = parts.join('');
    if ($('legend').innerHTML !== html) $('legend').innerHTML = html;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Unit time: a histogram with a range on it, and under it which parts of the first tree take the time at each unit
  // time.

  let RC = null, drag = null;
  function rangeDomain() {
    const key = JSON.stringify(S.side);
    if (RC && RC.key === key) return RC;
    const all = X.unitsInView(false), units = all.left.concat(all.right);
    for (const list of all.markers.values()) units.push(...list);
    let lo = Infinity, hi = -Infinity;
    for (const i of units) { const v = Math.log10(Math.max(data.units[i].ms, 1e-3)); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!units.length) { lo = 0; hi = 3; }
    lo -= 0.03; hi += 0.03;
    const NB = 64, counts = new Float64Array(NB);
    for (const i of units) counts[clamp(Math.floor((Math.log10(Math.max(data.units[i].ms, 1e-3)) - lo) / (hi - lo) * NB), 0, NB - 1)]++;
    RC = { key, lo, hi, counts, NB, all, dom: null, domSvg: null };
    return RC;
  }

  // The filter's chip says what the range is; the card with the histogram opens under it.
  function renderChip() {
    const r = S.range;
    $('range-value').textContent = r ? `${X.round3(r[0])}–${X.round3(r[1])} ms` : 'all';
    $('range-chip').classList.toggle('on', !!r);
    $('range-clear').hidden = !r;
  }
  function placeCard() {
    const card = $('rangecard'), chip = $('range-chip').getBoundingClientRect(), stage = $('stage').getBoundingClientRect();
    card.style.left = `${clamp(chip.left - stage.left, 8, Math.max(8, stage.width - card.offsetWidth - 8))}px`;
    card.style.top = `${chip.bottom - stage.top + 6}px`;
  }
  function toggleRange(open) {
    $('rangecard').hidden = !open;
    $('range-chip').setAttribute('aria-expanded', String(open));
    if (open) { placeCard(); renderCard(); placeCard(); }
  }

  function renderCard() {
    const rc = rangeDomain(), card = $('rangecard'), svg = $('range-svg'), T = X.T;
    // The parts are named at the right of the chart, so both charts leave that much room.
    const LABELS = 160, W = svg.clientWidth || card.clientWidth - 24, PAD = 7, w = W - 2 * PAD - LABELS, END = PAD + w;
    const xOfL = (l) => PAD + (l - rc.lo) / (rc.hi - rc.lo) * w;
    const HIST = 30, RUG0 = 34, RUG1 = 41, DOM0 = RUG1 + 8, DOMH = 210;
    const AXY = DOM0 + DOMH + 13, Ht = AXY + 4;
    const out = [];
    const r = drag ? drag.range : S.range;
    const xa = xOfL(clamp(r ? Math.log10(r[0]) : rc.lo, rc.lo, rc.hi)), xb = xOfL(clamp(r ? Math.log10(r[1]) : rc.hi, rc.lo, rc.hi));
    const peak = Math.log1p(Math.max(...rc.counts));
    let inside = '', outside = '';
    for (let b = 0; b < rc.NB; b++) {
      if (!rc.counts[b]) continue;
      const h = Math.max(1.5, Math.log1p(rc.counts[b]) / peak * HIST), x0 = PAD + b / rc.NB * w, bw = w / rc.NB;
      const d = `M${n1(x0 + 0.5)} ${n1(HIST)}v${n1(-h)}h${n1(Math.max(1, bw - 1))}v${n1(h)}Z`;
      if (x0 + bw / 2 >= xa && x0 + bw / 2 <= xb) inside += d; else outside += d;
    }
    out.push(`<path d="${outside}" fill="${T.faint}" fill-opacity="0.45"/><path d="${inside}" fill="${T.ink}" fill-opacity="0.7"/>`);
    // With a what-if, its compile times as an outline over the measured ones, on the same buckets.
    if (X.proj()) {
      const proj = new Float64Array(rc.NB);
      for (const i of rc.all.left.concat(rc.all.right, ...rc.all.markers.values())) {
        proj[clamp(Math.floor((Math.log10(Math.max(X.totalMs(i, false), 1e-3)) - rc.lo) / (rc.hi - rc.lo) * rc.NB), 0, rc.NB - 1)]++;
      }
      const top = Math.max(peak, Math.log1p(Math.max(...proj)));
      let d = `M${n1(PAD)} ${HIST}`;
      for (let b = 0; b < rc.NB; b++) {
        const y = proj[b] ? HIST - Math.max(1.5, Math.log1p(proj[b]) / top * HIST) : HIST;
        d += `V${n1(y)}H${n1(PAD + (b + 1) / rc.NB * w)}`;
      }
      out.push(`<path d="${d}V${HIST}" fill="none" stroke="${T.m3}" stroke-width="1.5" stroke-linejoin="round"><title>${esc(X.UNIT)} times if the what-if held</title></path>`);
    }
    let rug = '';
    for (const i of rc.all.right) rug += `M${n1(xOfL(Math.log10(Math.max(data.units[i].ms, 1e-3))))} ${RUG0}V${RUG1}`;
    if (rug) out.push(`<path d="${rug}" stroke="${T.right}" stroke-opacity="0.8"/>`);
    for (const [g, units] of rc.all.markers) for (const i of units) {
      out.push(`<circle cx="${n1(xOfL(Math.log10(Math.max(data.units[i].ms, 1e-3))))}" cy="${(RUG0 + RUG1) / 2}" r="3" fill="${T.surface}" stroke="${T[`m${X.slotOf(g)}`]}" stroke-width="1.5"/>`);
    }
    if (S.sel !== null) out.push(`<path d="M${n1(xOfL(Math.log10(Math.max(data.units[S.sel].ms, 1e-3))))} 0V${RUG1}" stroke="${T.sel}" stroke-width="2"/>`);
    if (!rc.dom || rc.domKey !== X.scenarioKey()) { rc.dom = coarsen(bucketShares(rc)); rc.domKey = X.scenarioKey(); }
    const domKey = `${W}|${T.scheme}|${rc.domKey}`;
    if (!rc.domSvg || rc.domSvg.key !== domKey) rc.domSvg = { key: domKey, svg: dominanceSvg(rc, xOfL, DOM0, DOMH, W).join('') };
    out.push(rc.domSvg.svg);
    for (let e = Math.ceil(rc.lo); e <= Math.floor(rc.hi); e++) {
      out.push(`<path d="M${n1(xOfL(e))} ${n1(AXY - 11)}v3" stroke="${T.line}"/>`);
      out.push(X.txt(xOfL(e), AXY, X.decade(10 ** e), { anchor: 'middle', fill: T.muted, size: 10.5, tabular: true }));
    }
    // Outside the range: veiled, the parts too; the handles stand on the histogram only.
    const veilH = DOM0 + DOMH;
    if (xa > PAD) out.push(`<rect x="0" y="0" width="${n1(xa)}" height="${veilH}" fill="${T.surface}" fill-opacity="0.62"/>`);
    if (xb < END) out.push(`<rect x="${n1(xb)}" y="0" width="${n1(END + PAD - xb)}" height="${veilH}" fill="${T.surface}" fill-opacity="0.62"/>`);
    for (const x of [xa, xb]) {
      out.push(`<path d="M${n1(x)} 0V${RUG1 + 1}" stroke="${T.ink}" stroke-width="1.5"/>`);
      out.push(`<rect x="${n1(x - 4)}" y="${n1(HIST / 2 - 9)}" width="8" height="18" rx="3" fill="${T.surface}" stroke="${T.ink}" stroke-width="1.5"/>`);
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${Ht}`);
    svg.setAttribute('height', Ht);
    svg.innerHTML = out.join('');
    Object.assign(rc, { W, PAD, w, xOfL, DOM0, DOMH });
    const shown = r || [10 ** rc.lo, 10 ** rc.hi];
    if (document.activeElement !== $('range-lo')) $('range-lo').value = String(X.round3(shown[0]));
    if (document.activeElement !== $('range-hi')) $('range-hi').value = String(X.round3(shown[1]));
    $('range-all').disabled = !r;
  }

  // The parts' colours, softened toward the card so the stack reads like the rest of the page.
  const partFill = X.partFill;

  // Parts by time: each histogram bucket's compilations averaged, part by part, and the buckets joined by a curve
  // through them that never overshoots, its shares then scaled to meet 100% again. A bucket of fewer than FEW
  // compilations joins the next until together they have FEW, so no curve runs through one compilation's mix; such
  // joined stretches, and empty ones between buckets, are veiled.
  const FEW = 5;
  function bucketShares(rc) {
    const P = data.partition.length, NB = rc.NB, at = (l) => clamp(Math.floor((l - rc.lo) / (rc.hi - rc.lo) * NB), 0, NB - 1);
    const sum = Array.from({ length: NB }, () => new Float64Array(P)), n = new Float64Array(NB), logs = new Float64Array(NB);
    // With a what-if, each column's own time takes its factors, and each unit sits at the time it would take.
    const proj = X.proj();
    const row = new Float64Array(P);
    for (const i of rc.all.left.concat(rc.all.right)) {
      const u = data.units[i];
      let total = 0;
      for (let p = 0; p < P; p++) {
        row[p] = proj ? proj.own[i * proj.P + p] : u.p[p];
        total += row[p];
      }
      const l = Math.log10(Math.max(proj ? X.totalMs(i, false) : u.ms, 1e-3)), b = at(l);
      n[b]++;
      logs[b] += l;
      for (let p = 0; p < P; p++) sum[b][p] += total > 0 ? row[p] / total : 0;
    }
    const groups = [];
    let cur = null;
    for (let b = 0; b < NB; b++) {
      if (!n[b]) continue;
      if (!cur) cur = { b0: b, b1: b, n: 0, logs: 0, sum: new Float64Array(P) };
      cur.b1 = b; cur.n += n[b]; cur.logs += logs[b];
      for (let p = 0; p < P; p++) cur.sum[p] += sum[b][p];
      if (cur.n >= FEW) { groups.push(cur); cur = null; }
    }
    if (cur && groups.length) {
      const g = groups[groups.length - 1];
      g.b1 = cur.b1; g.n += cur.n; g.logs += cur.logs;
      for (let p = 0; p < P; p++) g.sum[p] += cur.sum[p];
    } else if (cur) groups.push(cur);
    const groupOf = new Int32Array(NB).fill(-1);
    groups.forEach((g, k) => { for (let b = g.b0; b <= g.b1; b++) groupOf[b] = k; });
    // Each group at the middle of its compilations' times.
    const xs = groups.map((g) => g.logs / g.n);
    const curves = Array.from({ length: P }, (_, p) => monotone(xs, groups.map((g) => g.sum[p] / g.n)));
    const G = 240, grid = new Float64Array(G), mean = [], neff = new Float64Array(G), wide = new Uint8Array(G);
    for (let j = 0; j < G; j++) {
      const x = rc.lo + (rc.hi - rc.lo) * j / (G - 1), row = new Float64Array(P), g = groups[groupOf[at(x)]];
      let total = 0;
      for (let p = 0; p < P; p++) { row[p] = Math.max(0, curves[p](x)); total += row[p]; }
      if (total > 0) for (let p = 0; p < P; p++) row[p] /= total;
      grid[j] = x;
      mean.push(row);
      neff[j] = g ? g.n : 0;
      wide[j] = !g || g.b1 > g.b0 ? 1 : 0;
    }
    return { grid, mean, neff, wide };
  }
  // Which parts the stack shows, adding up to the whole: the first tree's leaves, but a parent in place of its children
  // where at most one of them matters (the rest of its own time counting as one of them), and what is left small in
  // Other, last. A part matters if it is wide somewhere or wide on average.
  const WIDE = 0.1, BROAD = 0.05;
  function coarsen(dom) {
    const N1 = data.partition.length - 1, G = dom.grid.length, T = X.T, other = [];
    const total = (ks) => { const s = new Float64Array(G); for (let j = 0; j < G; j++) for (const k of ks) s[j] += dom.mean[j][k]; return s; };
    const matters = (ks) => { const s = total(ks); let top = 0, sum = 0; for (const v of s) { top = Math.max(top, v); sum += v; } return top >= WIDE || sum / G >= BROAD; };
    const kidsOf = (k) => (X.kids[k] || []).filter((c) => c < N1);
    const under = (k) => [k, ...kidsOf(k).flatMap(under)];
    const ks = (u) => u.flatMap((part) => part.ks);
    // Of several, those that matter, the others to Other; a split one, made of several parts, matters.
    const keep = (units) => {
      const kept = units.filter((u) => u.length > 1 || matters(ks(u)));
      for (const u of units) if (!kept.includes(u)) other.push(...ks(u));
      return kept;
    };
    function partsOf(k) {
      const kids = kidsOf(k);
      if (!kids.length) return [{ ks: [k], node: k }];
      const units = [[{ ks: [k], node: k, rest: true }], ...kids.map(partsOf)];
      const kept = units.filter((u) => u.length > 1 || matters(ks(u)));
      if (kept.length <= 1) return [{ ks: under(k), node: k }];
      return keep(units).flat();
    }
    const tops = data.columns.map((c, k) => k).filter((k) => k < N1 && X.parentIdx[k] < 0);
    const shown = keep([...tops.map(partsOf), [{ ks: [N1], node: N1 }]]).flat();
    if (other.length) shown.push({ ks: other, other: true });
    const parts = shown.map((part) => {
      const k = part.other ? N1 : part.node, name = k === N1 ? data.partition[N1].label : data.columns[k].label;
      const label = part.other ? 'Other' : part.rest ? `Rest of ${name}` : name;
      return { label, ks: part.ks, fill: part.other ? X.mix(X.partFill(N1), T.surface, 0.45) : X.partFill(k), stroke: T.parts[k] };
    });
    const mean = dom.mean.map((row) => Float64Array.from(parts, (part) => part.ks.reduce((a, k) => a + row[k], 0)));
    return { grid: dom.grid, mean, neff: dom.neff, wide: dom.wide, parts };
  }

  // A monotone cubic through the points (Fritsch and Carlson): smooth, and never past its neighbours; flat beyond the
  // ends.
  function monotone(xs, ys) {
    const n = xs.length;
    if (n < 2) return () => (n ? ys[0] : 0);
    const h = [], d = [], m = new Float64Array(n);
    for (let i = 0; i + 1 < n; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i + 1 < n; i++) {
      if (d[i - 1] * d[i] <= 0) continue;
      const a = 2 * h[i] + h[i - 1], b = h[i] + 2 * h[i - 1];
      m[i] = (a + b) / (a / d[i - 1] + b / d[i]);
    }
    return (x) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
      const t = (x - xs[lo]) / h[lo], t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h[lo] * m[hi];
    };
  }

  // The share of each part of compile time, stacked, against compile time, across the whole range: smooth bands with a
  // hairline of the card between them, each named once, at the right. Where a bucket has few compilations, or none,
  // the bands are lightly veiled.
  function dominanceSvg(rc, xOfL, y0, h, W) {
    const dom = rc.dom, parts = dom.parts, out = [], T = X.T, G = dom.grid.length;
    const mean = new Array(G);
    for (let j = 0, last = null; j < G; j++) { if (dom.neff[j] >= 1) last = dom.mean[j]; mean[j] = last; }
    for (let j = G - 1, next = null; j >= 0; j--) { if (mean[j]) next = mean[j]; else mean[j] = next; }
    if (!mean[0]) return out;
    const cum = mean.map((m) => { const row = [0]; for (let k = 0; k < parts.length; k++) row.push(row[k] + m[k]); return row; });
    rc.cum = { j0: 0, j1: G - 1, rows: cum };
    const yOf = (v) => y0 + v * h, xa = xOfL(dom.grid[0]), xb = xOfL(dom.grid[G - 1]);
    out.push(`<defs><clipPath id="dom-clip"><rect x="${n1(xa)}" y="${n1(y0)}" width="${n1(xb - xa)}" height="${n1(h)}" rx="6"/></clipPath></defs><g clip-path="url(#dom-clip)">`);
    for (let k = 0; k < parts.length; k++) {
      let top = '', bottom = '';
      for (let j = 0; j < G; j++) top += `${top ? 'L' : 'M'}${n1(xOfL(dom.grid[j]))} ${n1(yOf(cum[j][k]))}`;
      for (let j = G - 1; j >= 0; j--) bottom += `L${n1(xOfL(dom.grid[j]))} ${n1(yOf(cum[j][k + 1]))}`;
      out.push(`<path class="band" data-k="${k}" d="${top}${bottom}Z" fill="${parts[k].fill}" stroke="${T.surface}" stroke-width="1.2" stroke-linejoin="round"/>`);
    }
    // Few compilations: veiled.
    for (let j = 0; j < G;) {
      if (!dom.wide[j]) { j++; continue; }
      const a = j;
      while (j < G && dom.wide[j]) j++;
      // From halfway to the grid point before to halfway to the one after.
      const mid = (q) => (xOfL(dom.grid[clamp(q, 0, G - 1)]) + xOfL(dom.grid[clamp(q + 1, 0, G - 1)])) / 2;
      const x0 = mid(a - 1), x1 = mid(j - 1);
      out.push(`<rect class="sparse" x="${n1(x0)}" y="${n1(y0)}" width="${n1(Math.max(1, x1 - x0))}" height="${n1(h)}" fill="${T.surface}" fill-opacity="0.4"/>`);
    }
    out.push('</g>');
    // Names at the right, each level with its band's end, spread apart where bands are thin.
    const GAP = 12.5, at = parts.map((p, k) => ({ k, y: yOf((cum[G - 1][k] + cum[G - 1][k + 1]) / 2), ly: 0 }));
    // Pushed down to clear the one above, then back up from the bottom to stay inside the chart.
    at[0].ly = at[0].y;
    for (let q = 1; q < at.length; q++) at[q].ly = Math.max(at[q].y, at[q - 1].ly + GAP);
    at[at.length - 1].ly = Math.min(at[at.length - 1].ly, y0 + h - 4);
    for (let q = at.length - 2; q >= 0; q--) at[q].ly = Math.min(at[q].ly, at[q + 1].ly - GAP);
    for (const { k, y, ly } of at) {
      out.push(`<path d="M${n1(xb + 2)} ${n1(y)}C${n1(xb + 8)} ${n1(y)} ${n1(xb + 6)} ${n1(ly)} ${n1(xb + 12)} ${n1(ly)}" fill="none" stroke="${parts[k].stroke}" stroke-width="1.2"/>`);
      out.push(`<rect x="${n1(xb + 14)}" y="${n1(ly - 4)}" width="8" height="8" rx="2" fill="${parts[k].fill}"/>`);
      out.push(X.txt(xb + 26, ly, X.fitText(parts[k].label, 11, 400, W - xb - 30), { base: 'central', fill: T.ink, size: 11, extra: ` class="band-label" data-k="${k}"` }));
    }
    return out;
  }

  // The part under the pointer in the stack: lift it, fade the rest.
  function hoverBand(k) {
    const svg = $('range-svg');
    svg.classList.toggle('hl', k >= 0);
    svg.querySelectorAll('path.band.on').forEach((p) => p.classList.remove('on'));
    svg.querySelectorAll('.band-label.on').forEach((p) => p.classList.remove('on'));
    if (k >= 0) {
      svg.querySelector(`path.band[data-k="${k}"]`)?.classList.add('on');
      svg.querySelector(`.band-label[data-k="${k}"]`)?.classList.add('on');
    }
  }

  function cardPointer(e) {
    const rc = RC, svg = $('range-svg');
    if (!rc || rc.w === undefined) return null;
    const b = svg.getBoundingClientRect();
    const x = (e.clientX - b.left) * rc.W / b.width, y = (e.clientY - b.top) * rc.W / b.width;
    return { x, y, l: rc.lo + clamp((x - rc.PAD) / rc.w, 0, 1) * (rc.hi - rc.lo), px: e.clientX - b.left };
  }

  function wireCard() {
    const svg = $('range-svg'), cross = $('card-cross');
    svg.addEventListener('pointerdown', (e) => {
      const at = cardPointer(e);
      if (!at) return;
      const rc = RC, r = S.range || [10 ** rc.lo, 10 ** rc.hi];
      const xa = rc.xOfL(Math.log10(r[0])), xb = rc.xOfL(Math.log10(r[1]));
      drag = { which: Math.abs(at.x - xa) <= 9 ? 'a' : Math.abs(at.x - xb) <= 9 ? 'b' : 'new', start: at.l, moved: false, range: r.slice() };
      svg.setPointerCapture(e.pointerId);
      X.hideTip();
      cross.hidden = true;
    });
    svg.addEventListener('pointermove', (e) => {
      const at = cardPointer(e);
      if (!at) return;
      if (!drag) {
        if (RC && at.y >= RC.DOM0 && at.y <= RC.DOM0 + RC.DOMH) {
          const b = svg.getBoundingClientRect(), c = $('rangecard').getBoundingClientRect();
          cross.hidden = false;
          cross.style.transform = `translateX(${Math.round(b.left - c.left + at.px)}px)`;
          cross.style.top = `${b.top - c.top + RC.DOM0 * b.width / RC.W}px`;
          cross.style.height = `${RC.DOMH * b.width / RC.W}px`;
          const dom = RC.dom, j = clamp(Math.round((at.l - RC.lo) / (RC.hi - RC.lo) * (dom.grid.length - 1)), 0, dom.grid.length - 1);
          const cum = RC.cum && j >= RC.cum.j0 && j <= RC.cum.j1 ? RC.cum.rows[j - RC.cum.j0] : null;
          if (cum) {
            const v = (at.y - RC.DOM0) / RC.DOMH;
            let k = 0;
            while (k < RC.dom.parts.length - 1 && cum[k + 1] <= v) k++;
            hoverBand(k);
            const s = $('stage').getBoundingClientRect();
            const share = (q) => cum[q + 1] - cum[q];
            const rest = RC.dom.parts.map((p, q) => [q, share(q)]).filter(([q, m]) => q !== k && m >= 0.02).sort((a, b2) => b2[1] - a[1]).slice(0, 2);
            const near = !dom.neff[j] ? `none around ${X.fmtMs(10 ** dom.grid[j])}: drawn between its neighbours`
              : `${X.nUnits(dom.neff[j])} around ${X.fmtMs(10 ** dom.grid[j])}${dom.wide[j] ? ', few: from a wider stretch' : ''}${X.proj() ? ', if the what-if held' : ''}`;
            X.tip([`${RC.dom.parts[k].label} · ${X.fmtPct(share(k))}`, near,
              ...rest.map(([q, m]) => `${RC.dom.parts[q].label} ${X.fmtPct(m)}`)], e.clientX - s.left, e.clientY - s.top);
          } else { hoverBand(-1); X.hideTip(); }
        } else { cross.hidden = true; hoverBand(-1); X.hideTip(); }
        return;
      }
      drag.moved = true;
      const v = 10 ** at.l;
      if (drag.which === 'a') drag.range[0] = Math.min(v, drag.range[1]);
      else if (drag.which === 'b') drag.range[1] = Math.max(v, drag.range[0]);
      else drag.range = [10 ** Math.min(drag.start, at.l), 10 ** Math.max(drag.start, at.l)];
      renderCard();
    });
    svg.addEventListener('pointerup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.moved) setRange(d.range); else renderCard();
    });
    svg.addEventListener('pointerleave', () => { cross.hidden = true; hoverBand(-1); if (!drag) X.hideTip(); });
    svg.addEventListener('dblclick', () => setRange(null));
    for (const [id, k] of [['range-lo', 0], ['range-hi', 1]]) {
      $(id).addEventListener('change', () => {
        const v = parseFloat($(id).value.replace(',', '.'));
        if (!Number.isFinite(v) || v <= 0) { renderCard(); return; }
        const r = (S.range || [10 ** RC.lo, 10 ** RC.hi]).slice();
        r[k] = v;
        setRange(r[0] <= r[1] ? r : [r[1], r[0]]);
      });
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(id).blur(); });
    }
    $('range-chip').addEventListener('click', () => toggleRange($('rangecard').hidden));
    $('range-clear').addEventListener('click', () => setRange(null));
    $('range-all').addEventListener('click', () => setRange(null));
  }

  function setRange(r) {
    if (r && RC && r[0] <= 10 ** RC.lo * 1.0001 && r[1] >= 10 ** RC.hi * 0.9999) r = null;
    S.range = r ? [X.round3(r[0]), X.round3(r[1])] : null;
    dropHidden();
    X.spans.invalidate();
    X.render();
  }
  X.setRange = setRange;

  // ---------------------------------------------------------------------------------------------------------
  // Finding a compilation by pasting its trace id or fingerprint, a short message, and the keyboard sheet.

  X.toast = (text) => {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.hidden = true; }, 2600);
  };

  // A trace id or a query fingerprint pasted anywhere outside a field selects its compilation.
  function pasted(text) {
    const q = text.trim().toLowerCase();
    if (q.length < 6 || /\s/.test(q)) return false;
    const i = data.units.findIndex((u) => (u.t && u.t.toLowerCase() === q) || (u.fp && u.fp.toLowerCase().startsWith(q)));
    if (i < 0) { X.toast(`No ${X.UNIT} span has that trace id or fingerprint`); return true; }
    const u = data.units[i];
    if (!X.included(u.g) || (S.range && (u.ms < S.range[0] || u.ms > S.range[1]))) { X.toast(`${u.l} is left out by the filters`); return true; }
    X.select(i);
    return true;
  }

  function keysHtml() {
    const failed = (data.failures || []).length;
    const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join(' ');
    const rows = [
      [k('1', '2'), 'Phases: share of time or milliseconds'], [k('L'), 'Phases: linear scale or not'],
      [`Pinch, ${k('Ctrl')}+wheel`, 'Zoom: Phases, Timeline and flame graph'], ['Drag, wheel', 'Phases zoomed in: pan'],
      [k('Esc'), 'Timeline: back to where it was before the last jump in'],
      [`${k('W')} ${k('S')} · ${k('A')} ${k('D')}`, 'Flame chart and flame graph: zoom · pan'],
      [k('F'), 'All of it again; or double-click empty space'], ['Double-click', 'A span: fit it'],
      [`${k('Shift')}+click names`, 'Phases: pick violins to merge or remove'], [k('Delete'), 'Phases: remove the violins picked'],
      ['Drag a name', 'Phases: onto another violin, merge them; to the edge of a sibling, move it'],
      ['Double-click a name', 'Phases: rename it'],
      ['Paste', `A trace id or fingerprint: select its ${esc(X.UNIT)} span`], [k('Esc'), 'Close, then clear the selection'], [k('?'), 'This sheet'],
    ];
    const runs = X.RUNS.map((r, j) => `<tr><td>${X.fmtInt(r.units)}</td><td>${esc(X.runTitle(j))}</td></tr>`).join('');
    return `<h3>${esc(meta.title || X.UNIT)}</h3><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`
      + `<h4>Runs, in the order the time views show them</h4><table class="runs">${runs}</table>`
      + `<p>${esc(X.nUnits(data.units.length))}, built ${esc(meta.generated || '')}${failed ? `; ${X.fmtInt(failed)} more failed and are left out` : ''}.</p>`;
  }
  function toggleKeys(open) {
    const pop = $('keys');
    if (open) pop.innerHTML = keysHtml();
    pop.hidden = !open;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Wiring.

  function wire() {
    document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => X.go(b.dataset.tab)));
    document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => { S.mode = b.dataset.mode; X.render(); }));
    document.querySelectorAll('#scales button').forEach((b) => b.addEventListener('click', () => { S.linear = b.dataset.linear === 'true'; X.render(); }));
    document.querySelectorAll('#tl-modes button').forEach((b) => b.addEventListener('click', () => X.go('timeline', b.dataset.tl)));
    document.querySelectorAll('#prof-modes button').forEach((b) => b.addEventListener('click', () => X.go('profile', b.dataset.prof)));
    document.querySelectorAll('#table-modes button').forEach((b) => b.addEventListener('click', () => { S.tableTree = b.dataset.tree === 'true'; X.spans.invalidate(); X.render(); }));
    $('name-text').addEventListener('click', () => X.go('profile', 'callers'));
    $('name-clear').addEventListener('click', () => X.spans.pick(null));
    X.on('name', renderNameChip);

    const stage = $('stage');
    // By the path the event took, as its target may be gone by now: a card redrawn by its own click.
    const OWN = '#controls, #overview, #rangecard, #tip, #card-pop, #spans, #timeline, #keys, #toast, #v-add, #v-merge, #v-hide, .name-edit';
    const own = (e) => e.composedPath().some((el) => el.matches && el.matches(OWN));
    const at = (e) => { const b = stage.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    stage.addEventListener('pointermove', (e) => {
      if (own(e)) { if (S.view === 'violins') X.violins.leave(e); return; }
      const [px, py] = at(e);
      if (S.view === 'violins') X.violins.move(e, px, py);
      else if (S.view === 'flame') X.flame.move(e, px, py);
    });
    stage.addEventListener('pointerleave', () => { if (S.view === 'violins') X.violins.leave(); else X.hideTip(); });
    stage.addEventListener('pointerdown', (e) => {
      if (own(e) || e.button !== 0) return;
      const [px, py] = at(e);
      if (S.view === 'flame') { stage.setPointerCapture(e.pointerId); X.flame.down(e, px, py); }
      if (S.view === 'violins' && X.violins.down(e, px, py)) stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointerup', (e) => {
      if (S.view === 'violins') X.violins.up();
      if (own(e) && S.view !== 'flame') return;
      const [px, py] = at(e);
      if (S.view === 'flame') X.flame.up(e, px, py);
    });
    stage.addEventListener('click', (e) => {
      if (own(e)) return;
      const [px, py] = at(e);
      if (S.view === 'violins') X.violins.click(e, px, py);
    });
    stage.addEventListener('dblclick', (e) => {
      if (own(e)) return;
      const [px, py] = at(e);
      if (S.view === 'flame') X.flame.dbl(e, px, py);
      else if (S.view === 'violins') X.violins.dbl(e, px, py);
    });
    stage.addEventListener('wheel', (e) => {
      if (own(e)) return;
      const [px, py] = at(e);
      if ((S.view === 'flame' && X.flame.wheel(e, px)) || (S.view === 'violins' && X.violins.wheel(e, px, py))) e.preventDefault();
    }, { passive: false });

    $('legend').addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (b) {
        S.side[b.dataset.g] = nextSide(b.dataset.g);
        if (S.sel !== null && S.side[data.units[S.sel].g] === 'off') X.select(null);
        X.spans.invalidate();
        X.render();
        return;
      }
      const inc = e.target.closest('[data-include]');
      if (!inc) return;
      const g = inc.dataset.include;
      X.setIncluded(g, !X.included(g));
      dropHidden();
      X.spans.invalidate();
      X.render();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!$('keys').hidden && !e.target.closest('#keys')) toggleKeys(false);
      if (!$('rangecard').hidden && !e.target.closest('#rangecard') && !e.target.closest('#range-chip')) toggleRange(false);
      if (S.card !== null && !e.target.closest('#card-pop, #v-add') && !e.target.closest('[data-col]')) X.panel.closeCard();
      if (!e.target.closest('#v-factor-menu, [data-pill]')) X.violins.closeMenu();
      if (!e.target.closest('#v-add, [data-add], [data-made-add]')) X.edit.closeAdd();
    });
    $('whatif-clear').addEventListener('click', () => { for (const id of [...S.factors.keys()]) S.factors.delete(id); X.setFactor('__none__', 1); });
    document.addEventListener('paste', (e) => {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (pasted((e.clipboardData || window.clipboardData).getData('text') || '')) e.preventDefault();
    });
    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest('input, select, textarea');
      if (e.key === 'Escape') {
        if (!$('keys').hidden) toggleKeys(false);
        else if (!$('rangecard').hidden) toggleRange(false);
        else if (X.edit.closeAdd()) { /* closed the + list */ }
        else if (X.violins.closeMenu()) { /* closed the factors */ }
        else if (S.card !== null) X.panel.closeCard();
        else if (X.edit.clearPicked()) { /* let the picked violins go */ }
        else if (X.nav.back()) { /* back to where the time views were before a jump in */ }
        else if (S.sel !== null) X.select(null);
        else if (S.name !== null) X.spans.pick(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') { toggleKeys($('keys').hidden); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && S.view === 'violins' && X.picked.size) { X.edit.removePicked(); e.preventDefault(); return; }
      if (S.view === 'flame' && X.flame.key(e)) { e.preventDefault(); return; }
      if (S.view === 'timeline' && (e.key === 'f' || e.key === 'F')) { X.nav.fitAll(); e.preventDefault(); return; }
      if (S.view === 'violins') {
        if (e.key === 'f' || e.key === 'F') X.violins.fit();
        if (e.key === '1') { S.mode = 'share'; X.render(); }
        if (e.key === '2') { S.mode = 'ms'; X.render(); }
        if (e.key === 'l' || e.key === 'L') { S.linear = !S.linear; X.render(); }
      }
    });
    X.on('name', () => { if (S.view === 'flame') X.flame.render(); });
    wireCard();
    new ResizeObserver(() => X.schedule(X.render)).observe(stage);
    // The controls wrap onto a second line when the chips outgrow one: what is below them moves down.
    new ResizeObserver(() => { X.nav.place(); X.schedule(X.render); }).observe($('controls'));
    // Pinch zoom moves no layout, so the canvases redraw for it once it settles.
    let zoomTimer = 0;
    const rezoom = () => {
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => { if (S.view === 'violins') X.violins.rezoom(); else if (S.view === 'flame') X.flame.render(); }, 120);
    };
    if (window.visualViewport) for (const e of ['resize', 'scroll']) window.visualViewport.addEventListener(e, rezoom);
    const dark = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => { RC = null; X.violins.invalidate(); X.spans.invalidate(); X.render(); };
    (dark.addEventListener ? dark.addEventListener.bind(dark, 'change') : dark.addListener.bind(dark))(theme);
    new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // The unit's name where the markup leaves room for it.
  function nameUnit() {
    document.title = meta.title || X.UNIT;
    for (const el of document.querySelectorAll('[data-u]')) {
      for (const a of ['title', 'aria-label']) if (el.hasAttribute(a)) el.setAttribute(a, el.getAttribute(a).replaceAll('{unit}', X.UNIT));
      if (!el.children.length && el.textContent.includes('{unit}')) el.textContent = el.textContent.replaceAll('{unit}', X.UNIT);
    }
  }

  function start() {
    nameUnit();
    X.tokens();
    X.violins.init();
    X.edit.init();
    X.download.init();
    X.flame.init();
    X.spans.init();
    X.panel.init();
    X.timeline.init();
    X.nav.init();
    wire();
    X.render();
    // Every span tree, which the violins are built from; until then the Phases tab says how far reading has got.
    X.on('chunk', () => { if (!X.layout.ready && S.view === 'violins') X.schedule(X.render); });
    X.on('layout', () => {
      renderWhatif();
      X.violins.invalidate();
      X.spans.invalidate();
      X.flame.layoutChanged();
      RC = null;
      X.render();
      X.panel.renderCard();
    });
    X.prefetchChunks();
    // The other measure and scale, in the background, once the violins are there.
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 300));
    X.on('layout', () => idle(() => { for (const [mode, linear] of [['ms', false], ['share', true], ['ms', true]]) X.prepare(mode, linear); }));
  }

  const faces = ['400 12.5px "IBM Plex Sans"', '600 12.5px "IBM Plex Sans"', '500 11px "IBM Plex Sans"'];
  Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 1500))]).then(start, start);
  window.ExplorerApp = { X, S };
  window.TX.select = X.select;
})();
