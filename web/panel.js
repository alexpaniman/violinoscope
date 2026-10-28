// The selected unit's chip in the filter row (its name, workload and times, its trace id to copy, and clearing it),
// and a violin's card: what it is, its numbers, a chart, the units that spend most in it, a merged violin's members,
// what the what-if makes of them, and hiding, renaming, splitting it up or finding it in the Spans tab.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, esc, clamp, n1 } = X;

  let chip, card;

  function init() {
    chip = $('sel-chip'); card = $('card-pop');
    chip.addEventListener('click', (e) => {
      if (e.target.closest('[data-clear]')) { X.select(null); return; }
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        navigator.clipboard.writeText(copy.dataset.copy).then(() => {
          copy.textContent = '✓';
          setTimeout(() => { copy.textContent = '⧉'; }, 1400);
        }, () => X.toast(`Trace id ${copy.dataset.copy}`));
      }
    });
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { closeCard(); return; }
      const unit = e.target.closest('[data-unit]');
      if (unit) { const i = Number(unit.dataset.unit); if (S.sel === i) X.go('timeline'); else { X.select(i); renderCard(); } return; }
      const out = e.target.closest('[data-leave]');
      if (out) { X.layout.leave(out.dataset.leave); return; }
      const part = e.target.closest('[data-open-part]');
      if (part) { const b = card.getBoundingClientRect(); openCard(part.dataset.openPart, { left: b.left, right: b.right, top: b.top, bottom: b.top }); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = S.card;
      if (act.dataset.act === 'hide') { closeCard(); X.layout.hide(id); }
      else if (act.dataset.act === 'spans') { const name = X.layout.spanName(id); closeCard(); X.spans.pick(name); X.go('profile', 'callers'); }
      else if (act.dataset.act === 'split') { closeCard(); X.layout.ungroup(id); }
      else if (act.dataset.act === 'rename') {
        const h = card.querySelector('h3');
        h.innerHTML = `<input data-rename aria-label="Name" value="${esc(X.layout.label(id))}">`;
        const input = h.querySelector('input');
        input.focus();
        input.select();
      }
    });
    card.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-rename]')) return;
      if (e.key === 'Enter') { X.layout.rename(S.card, e.target.value); e.preventDefault(); }
      if (e.key === 'Escape') { renderCard(); e.stopPropagation(); }
    });
    card.addEventListener('focusout', (e) => { if (e.target.matches('[data-rename]') && S.card !== null) X.layout.rename(S.card, e.target.value); });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The selected compilation.

  function renderChip() {
    if (S.sel === null) { chip.hidden = true; chip.innerHTML = ''; return; }
    const i = S.sel, u = data.units[i], T = X.T, side = X.sideKey(u.g);
    const times = [`${X.fmtMs(u.ms)}`, u.cpu !== null && u.cpu !== undefined ? `${X.fmtMs(u.cpu)} CPU` : '', X.proj() ? `${X.fmtMs(X.totalMs(i, false))} if the scenario held` : '']
      .filter(Boolean).join(' · ');
    chip.hidden = false;
    chip.innerHTML = `<span class="chip" title="${esc(`${u.l}, ${X.groupName(u.g)}: ${times}\n${X.runTitle(X.runOf(i))}`)}">`
      + `${X.glyph(side === 'left' || side === 'right' ? side : 'marker', T[side])}<b>${esc(u.l)}</b><span>${X.fmtMs(u.ms)}</span></span>`
      + `<button class="chip-x" type="button" data-copy="${esc(u.t)}" title="Copy its trace id, ${esc(u.t)}" aria-label="Copy its trace id">⧉</button>`
      + `<button class="chip-x" type="button" data-clear title="Clear the selection (Esc)" aria-label="Clear the selection">×</button>`;
  }
  // The span picked in a view; the Timeline follows it.
  X.panelShowSpan = () => {};

  // ---------------------------------------------------------------------------------------------------------
  // The part card.

  function openCard(id, anchor) {
    S.card = id;
    card.dataset.part = id;
    card.hidden = false;
    renderCard();
    // Beside its column, from the top of the plot, inside the stage.
    const stage = $('stage').getBoundingClientRect(), G = X.violins.G;
    const c = G ? G.p.cols.findIndex((col) => col.id === id) : -1;
    const top = X.contentTop() - 4;
    card.style.maxHeight = `${Math.max(200, stage.height - top - 12)}px`;
    const w = card.offsetWidth;
    let left;
    if (c >= 0) {
      const x = G.xOf(c), room = G.colW / 2 + 10;
      left = x + room + w < stage.width - 12 ? x + room : x - room - w;
    } else left = anchor.left - stage.left;
    left = clamp(left, 12, stage.width - w - 12);
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    X.violins.drawHover();
  }
  function closeCard() {
    if (S.card === null) return;
    S.card = null;
    card.hidden = true;
    X.violins.drawHover();
  }

  // What it is; its numbers in each half; one chart, runs against time when its spans run more than once in a unit,
  // else its share against the unit's time; the units that spend most in it; a merged violin's members; and actions.
  function renderCard() {
    if (S.card === null) return;
    const root = S.card === X.ROOT, k = root ? -1 : data.columnIndex.get(S.card), T = X.T;
    if (!root && k === undefined) { closeCard(); return; }
    const col = root ? { id: X.ROOT, label: X.UNIT } : data.columns[k];
    const v = X.unitsInView(true);
    const halves = [['left', v.left, X.sideNames('left')], ['right', v.right, X.sideNames('right')]].filter(([, u]) => u.length);
    const crumbs = [];
    for (let p = root ? -1 : X.parentIdx[k]; p >= 0; p = X.parentIdx[p]) crumbs.unshift(p);
    const rows = [];
    const row = (name, f, cls, title) => rows.push(`<tr${cls ? ` class="${cls}"` : ''}><td${title ? ` title="${esc(title)}"` : ''}>${name}</td>${halves.map(([, u]) => `<td>${f(u)}</td>`).join('')}</tr>`);
    const time = (i) => (root ? data.units[i].ms : X.partMs(i, k, true));
    if (root) row('Spans', (u) => X.fmtInt(u.length));
    row('Time, median', (u) => X.fmtMs(X.median(u.map(time))));
    row('90th percentile', (u) => X.fmtMs(X.R.quantile(X.sortedOf(u.map(time)), 0.9)));
    if (!root && X.kids[k].length) {
      row('Own time, median', (u) => X.fmtMs(X.median(u.map((i) => data.units[i].o[k] * data.units[i].ms))), '', 'Its time that none of the violins shown under it counts');
    }
    if (!root && S.mode === 'ms') row('Share, median', (u) => X.fmtPct(X.median(u.map((i) => data.units[i].s[k]))));
    const seen = (u) => u.filter((i) => data.units[i].s[k] > 0).length / u.length;
    if (!root && halves.some(([, u]) => seen(u) < 0.995)) row(`In, of ${esc(X.UNIT)} spans`, (u) => X.fmtPct(seen(u)));
    const ck = root ? undefined : X.countFor.get(k);
    if (ck !== undefined) {
      row('Runs, median', (u) => X.fmtInt(Math.round(X.median(u.map((i) => data.units[i].c[ck])))));
      row('Per run, median', (u) => X.fmtUs(X.median(u.filter((i) => data.units[i].c[ck] > 0).map((i) => X.partMs(i, k, true) / data.units[i].c[ck]))));
    }
    const f = S.factors.has(col.id) ? S.factors.get(col.id) : 1;
    if (f !== 1) row(`Time, ${X.fmtFactor(f)}`, (u) => X.fmtMs(X.median(u.map((i) => X.partMs(i, k, false)))), 'proj');
    // What the what-if does to the whole compile time, whichever parts it changes: below 1× is slower.
    if (X.scenarioOn()) {
      const compile = (u, measured) => X.median(u.map((i) => X.totalMs(i, measured)));
      row(`${esc(X.UNIT)}, what if`, (u) => X.fmtMs(compile(u, false)), 'proj');
      row('Speed-up', (u) => `${(compile(u, true) / compile(u, false)).toFixed(2)}×`, 'proj');
    }
    // What it is: merged, or a span renamed, and in which tree.
    const kind = [];
    if (!root && col.merged) kind.push(`Merged: ${X.fmtInt(X.layout.size(col.id))} spans`);
    const spans = root ? null : X.layout.spanName(col.id);
    if (spans && spans !== col.label) kind.push(`Span: ${esc(spans)}`);
    if (!root && col.second) kind.push('In Projections: takes nothing from the tree on the left');
    let html = `<div class="card-top"><div><h3>${esc(col.label)}</h3>${kind.length ? `<div class="span-name">${kind.join(' · ')}</div>` : ''}`
      + `${crumbs.length ? `<div class="crumbs">${crumbs.map((p) => `<button type="button" data-open-part="${esc(data.columns[p].id)}">${esc(data.columns[p].label)}</button>`).join(' › ')}</div>` : ''}</div>`
      + '<button class="icon-btn" type="button" data-close aria-label="Close">×</button></div>'
      + `<table class="stats"><thead><tr><th></th>${halves.map(([hk, , name]) => `<th><span class="sw" style="background:${T[hk]}"></span>${esc(name)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    if (!root) html += ck !== undefined ? runsScatter(k, ck, halves) : shareScatter(k, halves);
    html += topUnits(k, halves, time);
    if (!root && col.merged) html += membersOf(col.id, halves);
    if (!root) {
      html += `<div class="card-actions"><button type="button" class="btn small" data-act="hide" title="Its parent still counts its time">Hide</button>`
        + '<button type="button" class="btn small" data-act="rename" title="Or double-click its name">Rename</button>'
        + (col.merged ? '<button type="button" class="btn small" data-act="split" title="Show what it merges on its own again">Split up</button>' : '')
        + (spans ? `<button type="button" class="btn small" data-act="spans" title="${esc(spans)} in the Spans tab: what calls it and what it calls">In Spans</button>` : '')
        + '</div>';
    }
    card.innerHTML = html;
  }

  // The units in view that spend the most in it: a click selects one, a click on the selected one opens the Timeline.
  function topUnits(k, halves, time) {
    const all = halves.flatMap(([, u]) => u).map((i) => [i, time(i)]).filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (!all.length) return '';
    const T = X.T;
    const rows = all.map(([i, ms]) => {
      const u = data.units[i], side = X.sideKey(u.g), sel = S.sel === i;
      const share = k < 0 ? '' : X.fmtPct(u.s[k]);
      return `<button type="button" class="top-unit${sel ? ' sel' : ''}" data-unit="${i}" title="${sel ? 'Open it in the Timeline' : 'Select it everywhere; click again for the Timeline'}">`
        + `${X.glyph(side === 'left' || side === 'right' ? side : 'marker', T[side])}<span class="nm">${esc(u.l)}<small>${esc(X.groupName(u.g))}</small></span>`
        + `<span class="ms">${X.fmtMs(ms)}${share ? `<small>${share}</small>` : ''}</span></button>`;
    });
    return `<div><p class="section-title">${k < 0 ? 'Longest' : 'Most time in it'}</p><div class="top-units">${rows.join('')}</div></div>`;
  }

  // A merged violin's members, largest first, each with its median share of the unit; × takes one out.
  function membersOf(id, halves) {
    const units = halves.flatMap(([, u]) => u);
    const list = X.layout.members(id).map((m) => {
      const ms = X.layout.msOf(m);
      return [m, X.median(units.map((i) => ms[i] / data.units[i].ms))];
    }).sort((a, b) => b[1] - a[1]);
    const SHOW = 12;
    const rows = list.slice(0, SHOW).map(([m, share]) => `<div class="member"><span class="nm${X.layout.isMerged(m) ? ' merged' : ''}">${esc(X.layout.label(m))}</span>`
      + `<span class="pct">${X.fmtPct(share)}</span><button type="button" class="chip-x" data-leave="${esc(m)}" title="Take it out of ${esc(X.layout.label(id))}" aria-label="Take it out">×</button></div>`);
    const more = list.length > SHOW ? `<div class="member more">and ${X.fmtInt(list.length - SHOW)} more</div>` : '';
    return `<div><p class="section-title">Merges, median share</p><div class="members">${rows.join('')}${more}</div></div>`;
  }

  // Its share against the unit's time, both halves, one dot per unit: whether it is what makes long units long.
  function shareScatter(k, halves) {
    const T = X.T, W = 320, H = 150, L = 40, Rt = 8, Tp = 6, B = 28;
    const pts = [];
    let xmin = Infinity, xmax = -Infinity, ymax = 0;
    for (const [hk, u] of halves) for (const i of u) {
      const x = Math.log10(Math.max(data.units[i].ms, 1e-3)), y = data.units[i].s[k];
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymax = Math.max(ymax, y);
      pts.push([hk, x, y]);
    }
    if (pts.length < 3 || ymax <= 0) return '';
    xmin = Math.floor(xmin); xmax = Math.max(xmin + 1, Math.ceil(xmax));
    const step = ymax > 0.5 ? 0.25 : ymax > 0.2 ? 0.1 : ymax > 0.08 ? 0.05 : ymax > 0.04 ? 0.02 : 0.01;
    const y1 = Math.ceil(ymax / step) * step;
    const Xp = (x) => L + (x - xmin) / (xmax - xmin) * (W - L - Rt), Yp = (y) => Tp + (1 - y / y1) * (H - Tp - B);
    const out = [`<p class="section-title">Share against ${esc(X.UNIT)} time</p><svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Its share of each ${esc(X.UNIT)} span against that span's time">`];
    for (let y = 0; y <= y1 + 1e-9; y += step) {
      out.push(`<path d="M${L} ${n1(Yp(y))}H${W - Rt}" stroke="${T.grid}"/>`);
      out.push(X.txt(L - 6, Yp(y), y ? `${Math.round(y * 100)}%` : '0', { anchor: 'end', base: 'central', fill: T.muted, size: 10.5, tabular: true }));
    }
    for (let e = xmin; e <= xmax; e++) {
      out.push(`<path d="M${n1(Xp(e))} ${Tp}V${H - B}" stroke="${T.grid}"/>`);
      out.push(X.txt(Xp(e), H - B + 13, X.decade(10 ** e), { anchor: 'middle', fill: T.muted, size: 10.5, tabular: true }));
    }
    out.push(X.txt((L + W - Rt) / 2, H - 2, `${X.UNIT} time`, { anchor: 'middle', fill: T.muted, size: 10.5 }));
    for (const hk of ['left', 'right']) {
      let d = '';
      for (const [h, x, y] of pts) if (h === hk) d += `M${n1(Xp(x))} ${n1(Yp(y))}h0`;
      if (d) out.push(`<path d="${d}" stroke="${T[hk]}" stroke-width="2.6" stroke-opacity="${hk === 'right' ? 0.9 : 0.3}" stroke-linecap="round" fill="none"/>`);
    }
    out.push('</svg>');
    return out.join('');
  }

  function runsScatter(k, ck, halves) {
    const T = X.T, W = 320, H = 160, L = 46, Rt = 8, Tp = 6, B = 28;
    const pts = [];
    let xmax = 1, ymin = Infinity, ymax = -Infinity;
    for (const [hk, u] of halves) for (const i of u) {
      const n = data.units[i].c[ck], ms = data.units[i].s[k] * data.units[i].ms;
      if (n < 1 || ms <= 0) continue;
      const x = Math.log10(n), y = Math.log10(Math.max(ms, 1e-4));
      xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      pts.push([hk, x, y]);
    }
    if (!pts.length) return '';
    ymin = Math.floor(ymin * 2) / 2; ymax = Math.ceil(ymax * 2) / 2;
    const x1 = Math.max(1, Math.ceil(xmax * 4) / 4);
    const Xp = (x) => L + x / x1 * (W - L - Rt), Yp = (y) => Tp + (ymax - y) / (ymax - ymin) * (H - Tp - B);
    const out = [`<p class="section-title">Runs against time</p><svg width="100%" viewBox="0 0 ${W} ${H}" role="img" aria-label="Runs against time for each ${esc(X.UNIT)} span">`,
      `<defs><clipPath id="sc"><rect x="${L}" y="${Tp}" width="${W - L - Rt}" height="${H - Tp - B}"/></clipPath></defs>`];
    for (let e = Math.ceil(ymin); e <= ymax; e++) {
      out.push(`<path d="M${L} ${n1(Yp(e))}H${W - Rt}" stroke="${T.grid}"/>`);
      out.push(X.txt(L - 6, Yp(e), X.decade(10 ** e), { anchor: 'end', base: 'central', fill: T.muted, size: 10.5, tabular: true }));
    }
    for (let e = 0; e <= x1; e++) {
      out.push(`<path d="M${n1(Xp(e))} ${Tp}V${H - B}" stroke="${T.grid}"/>`);
      out.push(X.txt(Xp(e), H - B + 13, X.fmtInt(10 ** e), { anchor: 'middle', fill: T.muted, size: 10.5, tabular: true }));
    }
    out.push(X.txt((L + W - Rt) / 2, H - 2, `runs per ${X.UNIT}`, { anchor: 'middle', fill: T.muted, size: 10.5 }));
    out.push('<g clip-path="url(#sc)">');
    const labels = [];
    for (let e = -4; e <= 2; e++) {
      const c = 10 ** e, ya = e, yb = e + x1;
      if (yb < ymin || ya > ymax) continue;
      out.push(`<path d="M${n1(Xp(0))} ${n1(Yp(ya))}L${n1(Xp(x1))} ${n1(Yp(yb))}" stroke="${T.line}" stroke-dasharray="3 3"/>`);
      const xs = Math.max(0, ymin - ya), ys = ya + xs;
      if (xs > x1 - 0.8 || ys > ymax - 0.3) continue;
      labels.push(`<text transform="translate(${n1(Xp(xs) + 5)} ${n1(Yp(ys) - 4)}) rotate(${n1(-Math.atan2(Yp(0) - Yp(1), Xp(1) - Xp(0)) * 180 / Math.PI)})" font-family="${X.SANS}" font-size="10" fill="${T.muted}">${c >= 1 ? `${c} ms` : `${Number((c * 1000).toPrecision(2))} µs`} per run</text>`);
    }
    for (const hk of ['left', 'right']) {
      let d = '';
      for (const [h, x, y] of pts) if (h === hk) d += `M${n1(Xp(x))} ${n1(Yp(y))}h0`;
      if (d) out.push(`<path d="${d}" stroke="${T[hk]}" stroke-width="2.6" stroke-opacity="${hk === 'right' ? 0.9 : 0.3}" stroke-linecap="round" fill="none"/>`);
    }
    out.push('</g>', ...labels, '</svg>');
    return out.join('');
  }

  X.panel = { init, render: renderChip, renderCard, closeCard };
  X.openCard = openCard;
})();
