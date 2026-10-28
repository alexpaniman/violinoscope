// The spans view, in two modes. Table: over every compilation in view, like Perfetto's slice table; as a list, every
// span name with its self time, total time, count, and how many names call it and it calls; as a tree, the call
// paths merged as in the flame graph, sorted within each level; with a compilation selected, its own times beside
// them. Callers and callees, while a name is picked: its callers merged
// above it and what it calls merged below, as speedscope's sandwich. A picked name is marked in every view.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, esc } = X;
  const ROWH = 15, INDENT = 16;  // bars as tall as the flame graph's

  let root, body, lastKey = null, rebuild = 0, partial = false;

  function init() {
    root = $('spans');
    body = $('spans-body');
    // Spans arriving fill in the links, the tree, and the callers and callees.
    X.on('chunk', () => {
      if (S.view !== 'spans' || !partial) return;
      clearTimeout(rebuild);
      rebuild = setTimeout(() => { lastKey = null; render(); }, 300);
    });
    root.addEventListener('click', (e) => {
      const level = e.target.closest('[data-level]');
      if (level) { setLevel(level.dataset.level); return; }
      const twist = e.target.closest('[data-twist]');
      if (twist) { toggle(twist.dataset.twist); return; }
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const key = th.dataset.sort;
        S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : (key === 'name' || key === 'part' ? 1 : -1) };
        lastKey = null;
        render();
        return;
      }
      // A row picks its name; in the tree, also the path it was picked on. Picked again, it lets go.
      const tr = e.target.closest('tr[data-name]');
      if (tr) {
        const path = tr.dataset.path || null, again = S.name === tr.dataset.name && S.namePath === path;
        pick(again ? null : tr.dataset.name, path);
        return;
      }
      // Anywhere else that does nothing of its own lets the name go; the graphs decide for themselves.
      if (e.target.closest('canvas, button, input, label')) return;
      if (S.name !== null) pick(null);
    });
    // Typing keeps the rows whose name has it; Escape clears it first.
    root.addEventListener('input', (e) => { if (e.target.matches('[data-find]')) { S.spansQuery = e.target.value; render(); } });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !e.target.matches('[data-find]') || !e.target.value) return;
      S.spansQuery = '';
      render();
      e.stopPropagation();
    });
  }

  // A name picked, or let go; its callers and callees go with it.
  function pick(name, path) {
    S.name = name;
    S.namePath = name === null ? null : path || null;
    lastKey = null;
    X.emit('name');
    if (name === null && S.tab === 'profile' && S.prof === 'callers') X.go('profile', 'table');
    else if (S.view === 'spans') X.render();
  }

  // Totals per name over a set of units, from each call path's totals: self time, total time, count, which groups have
  // it, and the violins its time counts toward, most first (a name called from several places can count toward
  // several). Kept for the same units and violins, so sorting only sorts.
  let agg = null;
  function aggregate(units, key) {
    if (agg && agg.key === key) return agg.rows;
    const into = new Map(), gIndex = new Map(data.groups.map((g, k) => [g.id, k]));
    for (const i of units) {
      const U = X.layout.pathsOf(i), g = gIndex.get(data.units[i].g);
      for (let j = 0; j < U.ids.length; j++) {
        const p = U.ids[j], name = X.layout.path(p).name, part = X.layout.partOfPath(p);
        let r = into.get(name);
        if (!r) { r = { name, part: -1, parts: new Map(), self: 0, total: 0, n: 0, groups: new Set() }; into.set(name, r); }
        r.parts.set(part, (r.parts.get(part) || 0) + U.self[j] + 1e-9);
        r.n += U.cnt[j];
        r.total += U.dur[j];
        r.self += U.self[j];
        r.groups.add(g);
      }
    }
    const rows = [...into.values()];
    for (const r of rows) {
      r.total /= 1000; r.self /= 1000;
      r.partList = [...r.parts].filter(([p]) => p >= 0).sort((a, b) => b[1] - a[1]).map(([p]) => p);
      r.part = r.partList.length ? r.partList[0] : -1;
    }
    agg = { key, rows };
    return rows;
  }

  // Which names call each name, and which it calls, from the compilations whose spans are in so far.
  let linkCache = null;
  function links(units) {
    const key = `${X.viewKey()}|${X.chunksLoaded()}`;
    if (linkCache && linkCache.key === key) return linkCache;
    const by = new Map();
    const of = (name) => { let e = by.get(name); if (!e) { e = { callers: new Set(), callees: new Set() }; by.set(name, e); } return e; };
    let loaded = 0;
    for (const i of units) {
      if (!X.hasSpans(i)) continue;
      loaded++;
      const rs = X.spansOf(i).rows;
      for (const s of rs) if (s.parent >= 0) { const p = rs[s.parent].name; of(s.name).callers.add(p); of(p).callees.add(s.name); }
    }
    if (loaded < units.length) X.prefetchChunks();
    linkCache = { key, by, loaded, all: units.length };
    return linkCache;
  }

  // The call paths merged, as the flame graph merges them: node 0 is the compiler's root, 1 + k that of asynchronous
  // track k. A node's own time is its time less that of the spans under it.
  let treeCache = null;
  function callTree(units) {
    const key = `${X.viewKey()}|${X.chunksLoaded()}`;
    if (treeCache && treeCache.key === key) return treeCache;
    const roots = X.TRACKS.map((t, k) => 1 + k);
    const nodes = [0, ...roots].map((r) => ({ name: '', part: -1, depth: -1, async: r > 0, kids: new Map(), dur: 0, n: 0, inner: 0, path: r ? `~${r}` : '' }));
    const into = (pk, s) => (s.lane >= 0 ? 1 + s.track : pk);
    let loaded = 0;
    for (const i of units) {
      if (!X.hasSpans(i)) continue;
      loaded++;
      const rows = X.spansOf(i).rows, map = new Int32Array(rows.length);
      rows.forEach((s, r) => {
        const pk = s.parent >= 0 ? map[s.parent] : 0, p = into(pk, s);
        let k = nodes[p].kids.get(s.name);
        if (k === undefined) {
          k = nodes.length;
          nodes.push({ name: s.name, part: s.part, depth: nodes[p].depth + 1, async: nodes[p].async, kids: new Map(), dur: 0, n: 0, inner: 0, path: `${nodes[p].path}\u0001${s.name}` });
          nodes[p].kids.set(s.name, k);
        }
        nodes[k].dur += s.dur;
        nodes[k].n++;
        if (p === pk && nodes[p].depth >= 0) nodes[p].inner += s.dur;
        map[r] = k;
      });
    }
    if (loaded < units.length) X.prefetchChunks();
    treeCache = { key, nodes, roots, into, loaded, all: units.length };
    return treeCache;
  }
  // The selected compilation's own times on the merged paths.
  function ownTimes(tree, unit) {
    if (unit === null || !X.hasSpans(unit)) return null;
    const { nodes, into } = tree, rows = X.spansOf(unit).rows, map = new Int32Array(rows.length).fill(-1);
    const dur = new Float64Array(nodes.length), inner = new Float64Array(nodes.length);
    rows.forEach((s, r) => {
      const pk = s.parent >= 0 ? map[s.parent] : 0;
      if (pk < 0) return;
      const p = into(pk, s), k = nodes[p].kids.get(s.name);
      if (k === undefined) return;
      dur[k] += s.dur;
      if (p === pk && nodes[p].depth >= 0) inner[p] += s.dur;
      map[r] = k;
    });
    return { dur, inner };
  }

  // Open or shut in the tree: as toggled, else open above the level set (two levels, at first).
  const isOpen = (node) => (S.treeOpen.has(node.path) ? S.treeOpen.get(node.path) : node.depth < S.treeLevel);
  // Every node shut or open down to a level, as the waterfall's buttons do.
  function setLevel(how) {
    if (!treeCache) return;
    const deepest = treeCache.nodes.reduce((m, q) => Math.max(m, q.depth), 0), now = Math.min(S.treeLevel, deepest + 1);
    S.treeLevel = { none: 0, less: Math.max(0, now - 1), more: now + 1 > deepest ? Infinity : now + 1, all: Infinity }[how];
    S.treeOpen.clear();
    lastKey = null;
    render();
  }
  function toggle(path) {
    const node = treeCache && treeCache.nodes.find((q) => q.path === path);
    if (!node) return;
    S.treeOpen.set(path, !isOpen(node));
    lastKey = null;
    render();
  }

  const VALUE = {
    name: (r) => r.name, part: (r) => (r.part >= 0 ? data.columns[r.part].label : '~'),
    self: (r) => r.self, total: (r) => r.total, n: (r) => r.n, callers: (r) => r.callers, callees: (r) => r.callees,
    oneSelf: (r) => (r.one ? r.one.self : -1), oneTotal: (r) => (r.one ? r.one.total : -1),
  };
  const compare = () => {
    const f = VALUE[S.sort.key] || VALUE.self;
    return (a, b) => {
      const x = f(a), y = f(b);
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * S.sort.dir || a.name.localeCompare(b.name);
    };
  };

  // The tree's rows in order, open nodes' children after them, each with which of its ancestors were last. Found: the
  // paths whose name has q and those above them, all open; the ones above only to show where they are.
  function treeRows(tree, one, q) {
    const { nodes, roots } = tree, cmp = compare(), out = [];
    const hit = (k) => nodes[k].name.toLowerCase().includes(q);
    const below = q ? new Uint8Array(nodes.length) : null;
    const mark = (k) => { let any = false; for (const c of nodes[k].kids.values()) if (mark(c) || hit(c)) any = true; below[k] = any ? 1 : 0; return any; };
    if (q) [0, ...roots].forEach(mark);
    const rowOf = (k) => {
      const nd = nodes[k];
      return { k, name: nd.name, part: nd.part, async: nd.async, path: nd.path, kids: nd.kids.size,
        open: q ? below[k] === 1 : isOpen(nd), context: q ? !hit(k) : false,
        self: Math.max(0, nd.dur - nd.inner), total: nd.dur, n: nd.n,
        one: one && one.dur[k] > 0 ? { self: Math.max(0, one.dur[k] - one.inner[k]), total: one.dur[k] } : null };
    };
    const visit = (list, lasts) => {
      const rs = (q ? list.filter((k) => below[k] || hit(k)) : list).map(rowOf).sort(cmp);
      rs.forEach((r, j) => {
        r.lasts = [...lasts, j === rs.length - 1];
        out.push(r);
        if (r.kids && r.open) visit([...nodes[r.k].kids.values()], r.lasts);
      });
    };
    visit([...nodes[0].kids.values(), ...roots.flatMap((q) => [...nodes[q].kids.values()])], []);
    return out;
  }
  // The tree's lines beside a row: through for each ancestor with more below it, and into the row itself; then the
  // arrow that opens or shuts it, but while finding, when the tree is open just to the paths found.
  function guide(r, T, finding) {
    const d = r.lasts.length - 1, w = d * INDENT + 14, h = 30, m = h / 2, open = r.kids && r.open;
    let p = '';
    for (let l = 1; l < d; l++) if (!r.lasts[l]) p += `M${(l - 1) * INDENT + 7.5} 0V${h}`;
    if (d > 0) {
      const x = (d - 1) * INDENT + 7.5;
      p += `M${x} 0V${r.lasts[d] ? m : h}M${x} ${m}H${x + 6}`;
    }
    const arrow = !r.kids || finding ? '' : open ? `M${d * INDENT + 3} ${m - 2}l4 4l4 -4` : `M${d * INDENT + 5} ${m - 4}l4 4l-4 4`;
    return `<svg class="guide" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${p}" stroke="${T.line}" fill="none"/>`
      + (arrow ? `<path d="${arrow}" fill="none" stroke="${T.muted}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` : '') + '</svg>'
      + (r.kids && !finding ? `<button type="button" class="twist" data-twist="${esc(r.path)}" style="left:${d * INDENT}px" aria-label="${open ? 'Shut' : 'Open'}" aria-expanded="${open}"></button>` : '');
  }

  function render() {
    if (S.view !== 'spans') return;
    root.style.top = `${X.contentTop()}px`;
    if (!X.layout.ready) {
      const [k, n] = X.layout.progress();
      body.innerHTML = `<p class="empty">Reading spans: ${k} of ${n} files</p>`;
      lastKey = null;
      return;
    }
    if (S.spansMode === 'callers') { renderCallers(); return; }
    const tree = S.tableTree, q = (S.spansQuery || '').trim().toLowerCase();
    // Narrow, the part's name goes: its colour stays beside the span's.
    const compact = root.clientWidth < (S.sel !== null ? 1260 : 980);
    const key = `${tree}|${X.viewKey()}|${S.sel}|${S.sort.key}|${S.sort.dir}|${S.name}|${S.namePath}|${X.T.scheme}|${compact}|${root.clientWidth}|${X.layout.version}|${X.chunksLoaded()}|${tree ? `${S.treeLevel}|${[...S.treeOpen].join()}` : ''}|${q}`;
    if (key === lastKey) return;
    lastKey = key;
    const scrollTop = root.scrollTop;
    const one = S.sel !== null, units = X.allInView(), T = X.T;
    partial = false;

    let rows, note = '', found = 0;
    if (tree) {
      const t = callTree(units);
      rows = treeRows(t, one ? ownTimes(t, S.sel) : null, q);
      if (t.loaded < t.all) { partial = true; note = `spans of ${X.fmtInt(t.loaded)} of ${X.nUnits(t.all)} in so far`; }
    } else {
      rows = aggregate(units, `${X.viewKey()}|${X.layout.version}`).slice();
      // The selected unit's own times, by name.
      const mine = new Map();
      if (one) {
        const U = X.layout.pathsOf(S.sel);
        for (let j = 0; j < U.ids.length; j++) {
          const name = X.layout.path(U.ids[j]).name, m = mine.get(name) || { self: 0, total: 0 };
          m.self += U.self[j] / 1000; m.total += U.dur[j] / 1000;
          mine.set(name, m);
        }
      }
      const ln = links(units);
      for (const r of rows) {
        r.one = mine.get(r.name) || null;
        const e = ln.by.get(r.name);
        r.callers = e ? e.callers.size : 0;
        r.callees = e ? e.callees.size : 0;
      }
      if (ln.loaded < ln.all) { partial = true; note = `callers and callees from ${X.fmtInt(ln.loaded)} of ${X.nUnits(ln.all)} so far`; }
      rows.sort(compare());
      if (q) { found = rows.length; rows = rows.filter((r) => r.name.toLowerCase().includes(q)); }
    }

    let all = 0;
    for (const i of units) all += data.units[i].ms;
    const groups = new Set(units.map((i) => data.units[i].g));
    const marks = !tree && groups.size > 1;
    const maxSelf = Math.max(1e-9, ...rows.map((r) => r.self)), maxTotal = Math.max(1e-9, ...rows.map((r) => r.total));
    const th = (k, label, cls, title) => `<th data-sort="${k}" class="${cls || ''}${S.sort.key === k ? ' on' : ''}"${title ? ` title="${esc(title)}"` : ''} aria-sort="${S.sort.key === k ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">`
      + `${label}<span class="arrow">${S.sort.key === k ? (S.sort.dir > 0 ? '↑' : '↓') : ''}</span></th>`;
    const time = (v, max) => `<td class="num time" title="${X.fmtPct(v / all)} of ${esc(X.UNIT)} time"><span class="v">${v > 0 ? X.fmtUs(v) : '–'}</span><span class="meter"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span></td>`;
    // The groups a span is in, when it is not in all of them.
    const inView = data.groups.map((g, k) => k).filter((k) => groups.has(data.groups[k].id));
    const glyphs = (r) => (marks && r.groups.size < inView.length ? `<span class="marks" title="${esc(`Only in ${inView.filter((k) => r.groups.has(k)).map((k) => X.groupName(data.groups[k].id)).join(', ')}`)}">${inView.filter((k) => r.groups.has(k)).map((k) => {
      const g = data.groups[k].id, side = X.sideKey(g);
      return X.glyph(side === 'left' || side === 'right' ? side : 'marker', T[side], X.groupName(g));
    }).join('')}</span>` : '');
    const u1 = one ? data.units[S.sel] : null;
    const maxOneSelf = Math.max(1e-9, ...rows.map((r) => (r.one ? r.one.self : 0))), maxOneTotal = Math.max(1e-9, ...rows.map((r) => (r.one ? r.one.total : 0)));
    const oneTime = (v, max) => (v === null ? '<td class="num time mine"><span class="v">–</span><span class="meter"></span></td>'
      : `<td class="num time mine" title="${X.fmtPct(v / u1.ms)} of ${esc(u1.l)}"><span class="v">${v > 0 ? X.fmtUs(v) : '–'}</span><span class="meter"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span></td>`);
    const swatch = (r) => (r.async
      ? `<i class="async" style="border-color:${r.part >= 0 ? T.cols[r.part] : T.line}" title="Asynchronous: on its own track, beside its parent"></i>`
      : `<i style="background:${r.part >= 0 ? T.cols[r.part] : T.unowned}"></i>`);
    // The selected unit's own name and time are in its chip already.
    const matched = q ? rows.filter((r) => !r.context).length : 0;
    const scope = `<b>${esc(X.nUnits(units.length))}</b><span>${X.fmtMs(all)} in all</span>`
      + (note ? `<span class="note">${note}</span>` : '')
      + (q ? `<span class="found">${tree ? `${X.fmtInt(matched)} ${matched === 1 ? 'path' : 'paths'}` : `${X.fmtInt(matched)} of ${X.fmtInt(found)} names`}</span>` : '')
      + `<input class="spans-find" data-find type="search" autocomplete="off" spellcheck="false" placeholder="Find a span" aria-label="Find a span" value="${esc(S.spansQuery || '')}">`;
    // In the tree, the waterfall's buttons beside "Span": every node shut, a level less, a level more, every node open.
    const fold = (to, label, d) => `<button type="button" data-level="${to}" title="${label}" aria-label="${label}"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    const folds = '<span class="tl-folds" role="group" aria-label="Open or shut the tree">'
      + fold('none', 'Collapse all', 'M3.5 6.5 7 3l3.5 3.5M3.5 11 7 7.5l3.5 3.5') + fold('less', 'Collapse a level', 'M3.5 9 7 5.5 10.5 9')
      + fold('more', 'Expand a level', 'M3.5 5 7 8.5 10.5 5') + fold('all', 'Expand all', 'M3.5 3 7 6.5 10.5 3M3.5 7.5 7 11l3.5-3.5') + '</span>';
    const head = (tree ? th('name', 'Span').replace('</th>', `${folds}</th>`) : th('name', 'Span'))
      + `${th('part', 'Counted in', '', 'The violin its own time counts toward')}${th('self', 'Self', 'num')}${th('total', 'Total', 'num')}`
      + th('n', 'Count', 'num', tree ? 'Spans on this path' : 'Spans of this name')
      + (tree ? '' : `${th('callers', 'Callers', 'num', 'How many span names call it')}${th('callees', 'Callees', 'num', 'How many span names it calls')}`)
      + (one ? `${th('oneSelf', `${esc(u1.l)} self`, 'num mine')}${th('oneTotal', `${esc(u1.l)} total`, 'num mine')}` : '');
    const table = `<table class="spans-table${compact ? ' compact' : ''}${tree ? ' tree' : ''}"><thead><tr>${head}</tr></thead><tbody>`
      // The row picked strongly; in the tree, the name's other paths lightly.
      + rows.map((r) => `<tr data-name="${esc(r.name)}"${tree ? ` data-path="${esc(r.path)}"` : ''}${S.name !== r.name ? (r.context ? ' class="context"' : '')
        : !tree || !S.namePath || S.namePath === r.path ? ' class="here"' : ' class="on"'}>`
        + `<td class="name">${tree ? `<div class="cell">${guide(r, T, !!q)}` : ''}${swatch(r)}<span class="nm"${r.part >= 0 ? ` title="${esc(data.columns[r.part].label)}"` : ''}>${esc(r.name)}</span>${glyphs(r)}${tree ? '</div>' : ''}</td>`
        + `<td class="part"${(r.partList || []).length > 1 ? ` title="${esc(r.partList.map((p) => data.columns[p].label).join(', '))}"` : ''}>${esc((r.partList || (r.part >= 0 ? [r.part] : [])).map((p) => data.columns[p].label).join(', '))}</td>`
        + `${time(r.self, maxSelf)}${time(r.total, maxTotal)}<td class="num count">${X.fmtInt(r.n)}</td>`
        + (tree ? '' : `<td class="num count">${X.fmtInt(r.callers)}</td><td class="num count">${X.fmtInt(r.callees)}</td>`)
        + `${one ? oneTime(r.one && r.one.self, maxOneSelf) + oneTime(r.one && r.one.total, maxOneTotal) : ''}</tr>`).join('')
      + '</tbody></table>';
    // Typing in the filter goes on in the new one.
    const typing = document.activeElement && document.activeElement.matches('[data-find]') ? document.activeElement.selectionStart : null;
    body.innerHTML = `<div class="spans-wrap"><div class="spans-scope">${scope}</div>${table}`
      + (q && !rows.length ? `<p class="spans-none">No span is called anything with “${esc(S.spansQuery.trim())}” in it.</p>` : '') + '</div>';
    if (typing !== null) { const f = body.querySelector('[data-find]'); f.focus(); f.setSelectionRange(typing, typing); }
    root.scrollTop = scrollTop;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Callers and callees.

  // Over every compilation in view, each outermost span of the name (one inside another of the same name counts
  // once): the chain of its ancestors, merged from it upward, and its subtree, merged from it downward. Both are as
  // wide as the name's whole time.
  function sandwich(name) {
    const node = (nm, part) => ({ name: nm, part, dur: 0, n: 0, kids: new Map() });
    const child = (p, nm, part) => { let c = p.kids.get(nm); if (!c) { c = node(nm, part); p.kids.set(nm, c); } return c; };
    const callers = node(name, -1), callees = node(name, -1);
    let loaded = 0, all = 0;
    for (const i of X.allInView()) {
      all++;
      if (!X.hasSpans(i)) continue;
      loaded++;
      const rs = X.spansOf(i).rows;
      for (let r = 0; r < rs.length; r++) {
        const s = rs[r];
        if (s.name !== name) continue;
        let inner = false;
        for (let p = s.parent; p >= 0 && !inner; p = rs[p].parent) inner = rs[p].name === name;
        if (inner) continue;
        callers.part = callees.part = s.part;
        callers.dur += s.dur; callers.n++;
        let c = callers;
        for (let p = s.parent; p >= 0; p = rs[p].parent) { c = child(c, rs[p].name, rs[p].part); c.dur += s.dur; c.n++; }
        callees.dur += s.dur; callees.n++;
        const at = new Map([[r, callees]]);
        for (let q = r + 1; q < rs.length && rs[q].depth > s.depth; q++) {
          const d = child(at.get(rs[q].parent), rs[q].name, rs[q].part);
          d.dur += rs[q].dur; d.n++;
          at.set(q, d);
        }
      }
    }
    if (loaded < all) X.prefetchChunks();
    return { callers, callees, loaded, all };
  }

  // A merged tree as bars: each as wide as its time against the root's, children heaviest first and squeezed into
  // their parent where together they outweigh it.
  function bars(rootNode) {
    const out = [];
    let depth = 0;
    const lay = (n, x0, scale, d) => {
      out.push({ x0, x1: x0 + n.dur * scale, d, n });
      depth = Math.max(depth, d);
      const kids = [...n.kids.values()].sort((a, b) => b.dur - a.dur);
      const sum = kids.reduce((acc, k) => acc + k.dur, 0), inner = sum > n.dur ? n.dur / sum : 1;
      let x = x0;
      for (const k of kids) { lay(k, x, scale * inner, d + 1); x += k.dur * scale * inner; }
    };
    if (rootNode.dur > 0) lay(rootNode, 0, 1 / rootNode.dur, 0);
    return { list: out, depth };
  }

  // The picked name's callers and callees, the width of the view, each under its own heading.
  function renderCallers() {
    if (S.name === null) { body.innerHTML = ''; lastKey = null; return; }
    const key = `callers|${X.viewKey()}|${S.name}|${X.T.scheme}|${root.clientWidth}|${X.chunksLoaded()}`;
    if (key === lastKey) return;
    lastKey = key;
    const T = X.T, sw = sandwich(S.name);
    partial = sw.loaded < sw.all;
    body.innerHTML = `<div class="sw-view"><div class="spans-scope"><b>${esc(S.name)}</b><span>${X.fmtMs(sw.callers.dur)} in ${X.fmtInt(sw.callers.n)} spans</span>`
      + (partial ? `<span class="note">spans of ${X.fmtInt(sw.loaded)} of ${esc(X.nUnits(sw.all))} in so far</span>` : '') + '</div>'
      + '<p class="sw-title">Called from</p><canvas class="sw-canvas" data-which="up" aria-label="What calls it, merged: its callers above it"></canvas>'
      + '<p class="sw-title">Calls</p><canvas class="sw-canvas" data-which="down" aria-label="What it calls, merged below it"></canvas></div>';
    const w = body.querySelector('.sw-title').clientWidth;
    const color = (n) => (n.part >= 0 ? T.cols[n.part] : T.unowned);
    // Callers inverted, the name at the bottom and its parent on it; callees from the name down.
    for (const [which, tree, inverted] of [['up', sw.callers, true], ['down', sw.callees, false]]) {
      const canvas = body.querySelector(`[data-which="${which}"]`), b = bars(tree);
      // A name with no callers, or nothing inside it, shows just its own bar.
      const h = (b.depth + 1) * ROWH, ctx = canvas.getContext('2d'), hot = [];
      for (const bar of b.list) {
        const x = bar.x0 * w, bw = (bar.x1 - bar.x0) * w, y = inverted ? (b.depth - bar.d) * ROWH : bar.d * ROWH;
        if (bw >= 0.5) hot.push({ x0: x, x1: x + Math.max(1, bw), y0: y, y1: y + ROWH, n: bar.n });
      }
      // Drawn as the flame graph draws its bars; the name picked outlined, and the bar under the pointer too.
      let over = null;
      const draw = () => {
        ctx.setTransform(...X.toView(X.fitCanvas(canvas, w, h)));
        ctx.clearRect(0, 0, w, h);
        ctx.font = `500 11px ${X.SANS}`;
        ctx.textBaseline = 'middle';
        for (const q of hot) {
          const c = color(q.n), bw = q.x1 - q.x0;
          ctx.fillStyle = c;
          ctx.fillRect(q.x0, q.y0, Math.max(1, bw - (bw > 3 ? 1 : 0)), ROWH - 1);
          if (q.n === tree || q === over) {
            ctx.strokeStyle = T.ink; ctx.lineWidth = q === over && q.n !== tree ? 1 : 1.5;
            ctx.strokeRect(q.x0 + 0.75, q.y0 + 0.75, Math.max(1, bw - 2.5), ROWH - 2.5);
          }
          if (bw > 26) {
            const t = X.fitText(q.n.name, 11, 500, bw - 8);
            if (t) { ctx.fillStyle = X.inkOn(c); ctx.fillText(t, q.x0 + 4, q.y0 + ROWH / 2); }
          }
        }
      };
      draw();
      const at = (e) => {
        const r = canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
        return hot.find((q) => px >= q.x0 && px <= q.x1 && py >= q.y0 && py < q.y1);
      };
      canvas.onpointermove = (e) => {
        const bar = at(e) || null;
        if (bar !== over) { over = bar; draw(); }
        canvas.style.cursor = bar && bar.n.name !== S.name ? 'pointer' : '';
        if (!bar) { X.hideTip(); return; }
        const st = $('stage').getBoundingClientRect();
        X.tip([bar.n.name, `${X.fmtMs(bar.n.dur)} · ${X.fmtPct(bar.n.dur / tree.dur)} of ${S.name}'s time`, `${X.fmtInt(bar.n.n)} spans`,
          bar.n.part >= 0 ? data.columns[bar.n.part].label : ''], e.clientX - st.left, e.clientY - st.top);
      };
      canvas.onpointerleave = () => { X.hideTip(); if (over) { over = null; draw(); } };
      // A bar's name becomes the one picked; empty space lets it go.
      canvas.onclick = (e) => {
        const bar = at(e);
        if (!bar) pick(null);
        else if (bar.n.name !== S.name) pick(bar.n.name);
      };
    }
  }

  X.spans = { init, render, pick, invalidate() { lastKey = null; } };
})();
