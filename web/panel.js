// The selected unit's chip in the filter row (its name, workload and times, its trace id to copy, and clearing it),
// and a violin's card: what it is, its name to edit, its share against the unit's time, its runs against its time,
// the units that spend most in it, what a merged violin is made of, and splitting it up or finding it in Spans.
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
      const level=e.target.closest('[data-unskip]');if(level){X.layout.unskip(level.dataset.unskip);return;}
      if(e.target.closest('[data-made]')){madeOpen=!madeOpen;renderCard();return;}
      const more=e.target.closest('[data-made-add]');if(more){X.edit.openAdd(S.card,more.getBoundingClientRect());return;}
      const hide=e.target.closest('[data-member-hide]');if(hide){X.layout.hide(hide.dataset.memberHide);return;}
      const remove=e.target.closest('[data-member-remove]');if(remove){X.layout.remove([remove.dataset.memberRemove]);return;}
      const member=e.target.closest('[data-reveal-part]');if(member){const id=member.dataset.revealPart;if(!X.layout.shown(id))X.layout.add([id],S.card);openCard(id,card.getBoundingClientRect());return;}
      const part=e.target.closest('[data-open-part]');if(part){openCard(part.dataset.openPart,card.getBoundingClientRect());return;}
      const act = e.target.closest('[data-act], button[data-rename]');
      if (!act) return;
      const id = S.card;
      if (act.dataset.act === 'hide') { closeCard(); X.layout.hide(id); }
      else if(act.dataset.act==='delete'){closeCard();X.layout.remove([id]);}
      else if (act.dataset.act === 'reset') { closeCard(); X.layout.fresh(); }
      else if (act.dataset.act === 'saved') { closeCard(); X.layout.reset(); }
      else if (act.dataset.act === 'spans') { const name = X.layout.spanNames(id)[0]; closeCard(); X.spans.pick(name); X.go('profile', 'callers'); }
      else if (act.dataset.act === 'split') { closeCard(); X.layout.ungroup(id); }
      else if (act.dataset.act === 'rename' || act.dataset.rename !== undefined) {
        const h = card.querySelector('h3');
        h.innerHTML = `<input data-rename aria-label="Name" value="${esc(X.layout.label(id))}">`;
        const input = h.querySelector('input');
        input.focus();
        input.select();
      }
    });
    card.addEventListener('keydown', (e) => {
      if (!e.target.matches('input[data-rename]')) return;
      if (e.key === 'Enter') { X.layout.rename(S.card, e.target.value); e.preventDefault(); }
      if (e.key === 'Escape') { renderCard(); e.stopPropagation(); }
    });
    card.addEventListener('focusout', (e) => { if (e.target.matches('input[data-rename]') && S.card !== null) X.layout.rename(S.card, e.target.value); });
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

  // Its name to edit and where it sits, with what can be done to it at the top: split up, find its span in Spans, or
  // for the root, start over. Then its share against the unit's time; its runs against its time, or what they always
  // are; and what it is made of, its spans, scrolling by itself, when merged or renamed.
  function renderCard() {
    if (S.card === null) return;
    const root = S.card === X.ROOT, k = root ? -1 : data.columnIndex.get(S.card);
    if (!root && k === undefined) { closeCard(); return; }
    const col = root ? { id: X.ROOT, label: X.UNIT } : data.columns[k];
    const v = X.unitsInView(true);
    const halves = [['left', v.left], ['right', v.right]].filter(([, u]) => u.length);
    const crumbs = [];
    for (let p = root ? -1 : X.parentIdx[k]; p >= 0; p = X.parentIdx[p]) crumbs.unshift(p);
    // Where it sits, with the levels taken out from between, muted: a click puts one back.
    const skipped = (id) => X.layout.skippedAbove(id).map((s) => `<button type="button" class="skipped" data-unskip="${esc(s)}" title="Put ${esc(X.layout.label(s))} back, with what is under it">${esc(X.layout.label(s))}</button>`);
    const where = (!root && col.second ? ['<span>Projections</span>'] : [])
      .concat(crumbs.flatMap((p) => [...skipped(data.columns[p].id), `<button type="button" data-open-part="${esc(data.columns[p].id)}">${esc(data.columns[p].label)}</button>`]))
      .concat(root ? [] : skipped(col.id));
    // Its one span name, also when merged from spans of one name: what calls it and what it calls, in Spans.
    const names = root ? [] : X.layout.spanNames(col.id);
    const tools = root ? [] : [
      col.merged ? '<button type="button" class="text-btn small" data-act="split">Split up</button>' : '',
      `<button type="button" class="quiet-btn" data-act="hide" title="Hide, keeping its share" aria-label="Hide violin">${X.visibilityIcon(true)}</button>`,
      names.length === 1 ? `<button type="button" class="text-btn small" data-act="spans" title="${esc(names[0])} in the Spans tab: what calls it and what it calls">In Spans</button>` : ''];
    const title = root ? esc(col.label) : `${col.merged?typeIcon():''}<button type="button" class="title-edit" data-rename title="Rename it">${esc(col.label)}</button>`;
    let html = `<div class="card-top"><div class="card-id"><h3>${title}</h3>${where.length ? `<div class="crumbs">${where.join(' › ')}</div>` : ''}</div>`
      + `<div class="card-tools">${tools.join('')}<button class="icon-btn" type="button" data-close aria-label="Close">×</button></div></div>`
      + totals(k, halves, root);
    if (root) {
      html += `<div class="card-row"><button type="button" class="text-btn small" data-act="reset" title="Only ${esc(X.UNIT)}">Start over</button>`
        + `${X.layout.saved ? '<button type="button" class="text-btn small" data-act="saved" title="The violins this page was saved with">Back to the saved violins</button>' : ''}</div>`;
    } else {
      if (col.dependency) html += `<p class="runs-line">Includes dependency-group coverage${col.second ? '' : ' within the enclosing phase'}; not an exact measure of blocked time.</p>`;
      else if (col.independent) html += '<p class="runs-line">Separate logical flow · measured independently of the elapsed-time breakdown.</p>';
      const blocked=X.layout.blockedBy(col.id);if(blocked)html+=`<p class="runs-line">Counted in ${esc(X.layout.label(blocked))} above.</p>`;
      html += shareScatter(k, halves) + runsOf(k, halves, col) + (X.layout.isRest(col.id) ? '<p class="runs-line">Recorded time outside this level’s model children. Hiding children does not change it.</p>' : madeOf(col.id, halves));
    }
    card.innerHTML = html;
  }

  // Its time summed over the units in view, and its share of theirs summed, per half; the root's, how many units and
  // their time summed: where the time adds up, which medians don't say.
  function totals(k, halves, root) {
    const T = X.T;
    const parts = halves.map(([hk, u]) => {
      let all = 0, mine = 0;
      for (const i of u) { all += data.units[i].ms; if (!root) mine += X.partMs(i, k, true); }
      const what = root ? `${X.fmtInt(u.length)} · ${X.fmtTotal(all)}` : `${X.fmtTotal(mine)} · ${X.fmtPct(all > 0 ? mine / all : NaN)}`;
      return `<span title="${esc(X.sideNames(hk))}">${X.glyph(hk, T[hk])}${what}</span>`;
    });
    const tip = root ? `How many ${X.UNIT} spans are in view, and their time summed` : `Its time summed over the ${X.UNIT} spans in view, and its share of their time summed`;
    return `<div class="totals" title="${esc(tip)}"><span class="k">In all</span>${parts.join('')}</div>`;
  }

  // Runs against time when how many times its spans run differs between units: at least two counts, each in 5% of
  // them. Else what the count is, and what each run takes.
  function runsOf(k, halves, col) {
    const counts = new Map();
    for (const [, u] of halves) for (const i of u) { const n = data.units[i].c[k]; if (n > 0) counts.set(n, (counts.get(n) || 0) + 1); }
    const present = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!present) return '';
    const what = (n) => (col.merged ? (n === 1 ? 'span' : 'spans') : (n === 1 ? 'run' : 'runs'));
    if ([...counts.values()].filter((m) => m >= 0.05 * present).length >= 2) return runsScatter(k, halves, what(2));
    const [n, m] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const units = halves.flatMap(([, u]) => u).filter((i) => data.units[i].c[k] === n);
    const each = n > 1 ? `, ${X.fmtUs(X.median(units.map((i) => X.partMs(i, k, true) / n)))} each` : '';
    const how = m === present ? 'Always' : `In ${X.fmtPct(m / present)} of ${esc(X.UNIT)} spans`;
    return `<p class="runs-line"><b>Runs</b> ${how}: ${n} ${what(n)}${each}</p>`;
  }

  // What its time is made of, on one line until opened: its spans, each with the span it runs under and its average
  // share of the unit's time, largest first, × taking one out of a merged violin; and the spans left out of it, each
  // to put back. Its + includes or excludes more. Long, the list scrolls by itself.
  let madeOpen=true;
  const typeIcon=()=>'<span class="definition-icon" title="Group">⊞</span>';
  function madeOf(id,halves){
    const group=X.layout.isMerged(id),members=X.layout.members(id),units=halves.flatMap(([,u])=>u);
    const share=id=>{const ms=X.layout.msOf(id);return units.length?units.reduce((s,i)=>s+ms[i]/data.units[i].ms,0)/units.length:0;};
    const rows=members.map(m=>`<div class="member"><span class="member-name">${group&&X.layout.isMerged(m)?typeIcon():''}${group?`<button type="button" class="text-btn input-label" data-reveal-part="${esc(m)}" title="Reveal and inspect">${esc(X.layout.label(m))}</button>`:`<span class="input-label">${esc(X.layout.spanName(id))}</span>`}</span><span class="pct">${X.fmtPct(share(m))}</span><span class="member-actions">${group?`<button type="button" class="quiet-btn" data-member-hide="${esc(m)}" title="Hide, keeping its share" aria-label="Hide member">${X.visibilityIcon(true)}</button><button type="button" class="quiet-btn" data-member-remove="${esc(m)}" title="Delete member" aria-label="Delete member">×</button>`:''}</span></div>`).join('');
    return `<div class="made${madeOpen?' open':''}"><div class="made-head"><button type="button" class="made-toggle" data-made aria-expanded="${madeOpen}"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span class="section-title">Made of</span><span class="n">${group?members.length:''}</span></button>${group?'<span class="made-tools"><button type="button" class="quiet-btn" data-made-add title="Add a member" aria-label="Add a member">+</button><span class="action-space"></span></span>':''}</div>${madeOpen?`<div class="members">${rows}</div>`:''}</div>`;
  }

  // Its share against the unit's time, both halves, one dot per unit: whether it is what makes long units long.
  function shareScatter(k, halves) {
    const T = X.T, W = 320, H = 132, L = 40, Rt = 8, Tp = 6, B = 28;
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
      out.push(X.txt(Xp(e), H - B + 13, X.decade(10 ** e), { anchor: e === xmax ? 'end' : 'middle', fill: T.muted, size: 10.5, tabular: true }));
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

  function runsScatter(k, halves, what) {
    const T = X.T, W = 320, H = 140, L = 46, Rt = 8, Tp = 6, B = 28;
    const pts = [];
    let xmax = 1, ymin = Infinity, ymax = -Infinity;
    for (const [hk, u] of halves) for (const i of u) {
      const n = data.units[i].c[k], ms = data.units[i].s[k] * data.units[i].ms;
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
    out.push(X.txt((L + W - Rt) / 2, H - 2, `${what} per ${X.UNIT}`, { anchor: 'middle', fill: T.muted, size: 10.5 }));
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
