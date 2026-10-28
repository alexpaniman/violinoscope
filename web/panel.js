// The selected unit's chip in the filter row (its name, workload and times, its trace id to copy, and clearing it),
// and a violin's card: its numbers, runs against time, what the what-if makes of them, and hiding, renaming or
// splitting it up.
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
      const part = e.target.closest('[data-open-part]');
      if (part) { const b = card.getBoundingClientRect(); openCard(part.dataset.openPart, { left: b.left, right: b.right, top: b.top, bottom: b.top }); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const id = S.card;
      if (act.dataset.act === 'hide') { closeCard(); X.layout.hide(id); }
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

  function renderCard() {
    if (S.card === null) return;
    // The whole compilation, the root, has its compile times; a part, its own.
    const root = S.card === X.ROOT, k = root ? -1 : data.columnIndex.get(S.card), T = X.T;
    if (!root && k === undefined) { closeCard(); return; }
    const col = root ? { id: X.ROOT, label: X.UNIT } : data.columns[k];
    const v = X.unitsInView(true);
    const halves = [['left', v.left, X.sideNames('left')], ['right', v.right, X.sideNames('right')]].filter(([, u]) => u.length);
    const crumbs = [];
    for (let p = root ? -1 : X.parentIdx[k]; p >= 0; p = X.parentIdx[p]) crumbs.unshift(p);
    const rows = [];
    const row = (name, f, cls) => rows.push(`<tr${cls ? ` class="${cls}"` : ''}><td>${name}</td>${halves.map(([, u]) => `<td>${f(u)}</td>`).join('')}</tr>`);
    const own = (i) => (root ? data.units[i].ms : X.partMs(i, k, true));
    if (root) row('Spans', (u) => X.fmtInt(u.length));
    else row('Share, median', (u) => X.fmtPct(X.median(u.map((i) => data.units[i].s[k]))));
    row('Time, median', (u) => X.fmtMs(X.median(u.map(own))));
    row('90th percentile', (u) => X.fmtMs(X.R.quantile(X.sortedOf(u.map(own)), 0.9)));
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
    let html = `<div class="card-top"><div><h3>${esc(col.label)}</h3>${crumbs.length ? `<div class="crumbs">${crumbs.map((p) => `<button type="button" data-open-part="${esc(data.columns[p].id)}">${esc(data.columns[p].label)}</button>`).join(' › ')}</div>` : ''}</div>`
      + '<button class="icon-btn" type="button" data-close aria-label="Close">×</button></div>'
      + `<table class="stats"><thead><tr><th></th>${halves.map(([hk, , name]) => `<th><span class="sw" style="background:${T[hk]}"></span>${esc(name)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    if (ck !== undefined) html += runsScatter(k, ck, halves);
    if (!root) {
      html += `<div class="card-actions"><button type="button" class="btn small" data-act="hide" title="Its parent still counts its time">Hide</button>`
        + (col.merged ? '<button type="button" class="btn small" data-act="rename">Rename</button><button type="button" class="btn small" data-act="split" title="Show what it merges on its own again">Split up</button>' : '')
        + '</div>';
    }
    card.innerHTML = html;
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
