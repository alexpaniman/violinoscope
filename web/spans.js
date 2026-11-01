// The spans table: over every compilation in view, like Perfetto's slice table; as a list, every
// span name with its self time, total time, count, and how many names call it and it calls; as a tree, the call
// paths merged as in the flame graph, sorted within each level; with a compilation selected, its own times beside
// them. Focused call trees feed the same flame-graph renderer as the full profile.
(function () {
  'use strict';
  const X = window.TX, S = X.S, data = X.data;
  const { $, esc, clamp } = X;
  const INDENT = 16;

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
    let scrollFrame = 0;
    root.addEventListener('scroll',()=>{
      if (!scrollFrame) scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;drawRows?.();});
    });
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
    if (S.view === 'spans') X.render();
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
        if (!r) { r = { name, part: -1, parts: new Map(), self: 0, total: 0, n: 0, flowN: 0, groups: new Set() }; into.set(name, r); }
        r.parts.set(part, (r.parts.get(part) || 0) + U.self[j] + 1e-9);
        r.n += U.cnt[j];
        r.flowN += U.flows[j];
        r.total += U.dur[j];
        r.self += U.self[j];
        r.groups.add(g);
      }
    }
    const rows = [...into.values()];
    for (const r of rows) {
      r.async = r.flowN > 0; r.mixed = r.async && r.flowN < r.n;
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
      const {flat:f, names} = X.rawSpans(i);
      for (let r = 0; r < f.length / 5; r++) {
        const p = f[r * 5 + 1];
        if (p >= 0) { const name = names[f[r * 5]], parent = names[f[p * 5]]; of(name).callers.add(parent); of(parent).callees.add(name); }
      }
    }
    if (loaded < units.length) X.prefetchChunks();
    linkCache = { key, by, loaded, all: units.length };
    return linkCache;
  }

  // The call paths merged, as the flame graph merges them: node 0 is the compiler's root, 1 + k that of asynchronous
  // track k. A node's own time is its time less that of the spans under it.
  let treeCache = null;
  function callTree(units) {
    const key = `${X.viewKey()}|${X.chunksLoaded()}|${X.layout.version}`;
    if (treeCache && treeCache.key === key) return treeCache;
    const roots = X.TRACKS.map((t, k) => 1 + k);
    const nodes = [0, ...roots].map((r) => ({ name: '', part: -1, depth: -1, async: r > 0, kids: new Map(), dur: 0, n: 0, inner: 0, path: r ? `~${r}` : '' }));
    const into = (pk, s) => (s.flowStart ? 1 + s.track : pk);
    let loaded = 0;
    for (const i of units) {
      if (!X.hasSpans(i)) continue;
      loaded++;
      const map = new Int32Array(X.rawSpans(i).flat.length / 5);
      X.eachSpan(i, (s, r) => {
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

  let drawRows = null;
  function render() {
    if (S.view !== 'spans') return;
    root.style.top = `${X.contentTop()}px`;
    if (!X.layout.ready) {
      const [k, n] = X.layout.progress();
      body.innerHTML = `<p class="empty">Reading spans: ${k} of ${n} files</p>`;
      lastKey = null;
      return;
    }
    // Line the search up with the full row of view/mode buttons, including when that row wraps.
    root.style.setProperty('--spans-find-width', `${$('controls').querySelector('.row').getBoundingClientRect().width}px`);
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
    const maxSelf = rows.reduce((v,r)=>Math.max(v,r.self),1e-9), maxTotal = rows.reduce((v,r)=>Math.max(v,r.total),1e-9);
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
    const maxOneSelf = rows.reduce((v,r)=>Math.max(v,r.one?.self||0),1e-9), maxOneTotal = rows.reduce((v,r)=>Math.max(v,r.one?.total||0),1e-9);
    const oneTime = (v, max) => (v === null ? '<td class="num time mine"><span class="v">–</span><span class="meter"></span></td>'
      : `<td class="num time mine" title="${X.fmtPct(v / u1.ms)} of ${esc(u1.l)}"><span class="v">${v > 0 ? X.fmtUs(v) : '–'}</span><span class="meter"><i style="width:${(v / max * 100).toFixed(1)}%"></i></span></td>`);
    const swatch = (r) => (r.async
      ? `<i class="async${r.mixed ? ' mixed' : ''}" style="--swatch:${r.part >= 0 ? T.cols[r.part] : T.line};border-color:var(--swatch)" title="${r.mixed ? `${X.fmtInt(r.flowN)} of ${X.fmtInt(r.n)} occurrences in separate logical flows` : 'In a separate logical flow'}"></i>`
      : `<i style="background:${r.part >= 0 ? T.cols[r.part] : T.unowned}"></i>`);
    // The selected unit's own name and time are in its chip already.
    const matched = q ? rows.filter((r) => !r.context).length : 0;
    const scope = `<input class="spans-find" data-find type="search" autocomplete="off" spellcheck="false" placeholder="Find a span" aria-label="Find a span" value="${esc(S.spansQuery || '')}">`
      + `<div class="spans-summary"><span title="${esc(`${X.fmtTotal(all)} total ${X.UNIT} time`)}">${esc(X.nUnits(units.length))}</span>`
      + (note ? `<span class="note">${note}</span>` : '')
      + (q ? `<span class="found">${tree ? `${X.fmtInt(matched)} ${matched === 1 ? 'path' : 'paths'}` : `${X.fmtInt(matched)} of ${X.fmtInt(found)} names`}</span>` : '') + '</div>';
    // In the tree, the waterfall's buttons beside "Span": every node shut, a level less, a level more, every node open.
    const fold = (to, label, d) => `<button type="button" data-level="${to}" title="${label}" aria-label="${label}"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    const folds = '<span class="tl-folds" role="group" aria-label="Open or shut the tree">'
      + fold('none', 'Collapse all', 'M3.5 6.5 7 3l3.5 3.5M3.5 11 7 7.5l3.5 3.5') + fold('less', 'Collapse a level', 'M3.5 9 7 5.5 10.5 9')
      + fold('more', 'Expand a level', 'M3.5 5 7 8.5 10.5 5') + fold('all', 'Expand all', 'M3.5 3 7 6.5 10.5 3M3.5 7.5 7 11l3.5-3.5') + '</span>';
    const head = (tree ? th('name', 'Span').replace('</th>', `${folds}</th>`) : th('name', 'Span'))
      + `${th('part', 'Counted in', '', 'The violin its own time counts toward')}${th('self', 'Self', 'num')}${th('total', 'Total', 'num')}`
      + th('n', X.meta.sampled_cpu ? 'Segments' : 'Count', 'num', X.meta.sampled_cpu ? 'Reconstructed stack segments, not invocation counts' : tree ? 'Spans on this path' : 'Spans of this name')
      + (tree ? '' : `${th('callers', 'Callers', 'num', 'How many span names call it')}${th('callees', 'Callees', 'num', 'How many span names it calls')}`)
      + (one ? `${th('oneSelf', `${esc(u1.l)} self`, 'num mine')}${th('oneTotal', `${esc(u1.l)} total`, 'num mine')}` : '');
    const cols = `<col>${compact?'':'<col style="width:180px">'}<col span="2" style="width:136px"><col span="${tree?1:3}" style="width:70px">${one?'<col span="2" style="width:136px">':''}`;
    const table = `<table class="spans-table${compact ? ' compact' : ''}${tree ? ' tree' : ''}"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody></tbody></table>`;
    const rowHtml = (r) => `<tr data-name="${esc(r.name)}"${tree ? ` data-path="${esc(r.path)}"` : ''}${S.name !== r.name ? (r.context ? ' class="context"' : '')
        : !tree || !S.namePath || S.namePath === r.path ? ' class="here"' : ' class="on"'}>`
        + `<td class="name">${tree ? `<div class="cell">${guide(r, T, !!q)}` : ''}${swatch(r)}<span class="nm"${r.part >= 0 ? ` title="${esc(data.columns[r.part].label)}"` : ''}>${esc(r.name)}</span>${glyphs(r)}${tree ? '</div>' : ''}</td>`
        + `<td class="part"${(r.partList || []).length > 1 ? ` title="${esc(r.partList.map((p) => data.columns[p].label).join(', '))}"` : ''}>${esc((r.partList || (r.part >= 0 ? [r.part] : [])).map((p) => data.columns[p].label).join(', '))}</td>`
        + `${time(r.self, maxSelf)}${time(r.total, maxTotal)}<td class="num count">${X.fmtInt(r.n)}</td>`
        + (tree ? '' : `<td class="num count">${X.fmtInt(r.callers)}</td><td class="num count">${X.fmtInt(r.callees)}</td>`)
        + `${one ? oneTime(r.one && r.one.self, maxOneSelf) + oneTime(r.one && r.one.total, maxOneTotal) : ''}</tr>`;
    // Typing in the filter goes on in the new one.
    const typing = document.activeElement && document.activeElement.matches('[data-find]') ? document.activeElement.selectionStart : null;
    body.innerHTML = `<div class="spans-wrap"><div class="spans-scope table-scope">${scope}</div>${table}`
      + (q && !rows.length ? `<p class="spans-none">No span is called anything with “${esc(S.spansQuery.trim())}” in it.</p>` : '') + '</div>';
    if (typing !== null) { const f = body.querySelector('[data-find]'); f.focus(); f.setSelectionRange(typing, typing); }
    root.scrollTop = scrollTop;
    const tbody=body.querySelector('tbody'), rowHeight=31, columns=(tree?5:7)+(one?2:0)-(compact?1:0);
    let previous=-1;
    drawRows=(position=root.scrollTop)=>{
      const offset=tbody.getBoundingClientRect().top-root.getBoundingClientRect().top+root.scrollTop;
      const first=clamp(Math.floor((position-offset)/rowHeight)-8,0,Math.max(0,rows.length-1));
      if(first===previous)return;
      previous=first;
      const end=Math.min(rows.length,first+Math.ceil(root.clientHeight/rowHeight)+20);
      const spacer=n=>n?`<tr aria-hidden="true" class="spans-spacer"><td colspan="${columns}" style="height:${n*rowHeight}px"></td></tr>`:'';
      tbody.innerHTML=spacer(first)+rows.slice(first,end).map(rowHtml).join('')+spacer(rows.length-end);
    };
    drawRows(scrollTop);
    root.scrollTop=scrollTop;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Callers and callees.

  // Within each flow, count outermost occurrences of the name. Boundaries preserve causal relationships through
  // origin links, and start independent callee graphs; their overlapping durations never divide a parent's width.
  let focusCache = null;
  function focusTree(name, units = X.allInView()) {
    const key = `${name}|${X.layout.version}|${X.chunksLoaded()}|${units.join(',')}`;
    if (focusCache?.key === key) return focusCache.value;
    const node = (nm, part) => ({ name: nm, part, dur: 0, n: 0, flowN: 0, kids: new Map() });
    const child = (p, nm, part) => { let c = p.kids.get(nm); if (!c) { c = node(nm, part); p.kids.set(nm, c); } return c; };
    const add = (n, dur, async) => { n.dur += dur; n.n++; if (async) n.flowN++; n.async = n.flowN > 0; n.mixed = n.async && n.flowN < n.n; };
    const callers = node(name, -1), callees = node(name, -1);
    const flows = new Map(), origins = new Set();
    let loaded = 0, all = 0;
    for (const i of units) {
      all++;
      if (!X.hasSpans(i)) continue;
      loaded++;
      const raw = X.rawSpans(i), nameId = raw.names.indexOf(name);
      if (nameId < 0) continue;
      const {flat:f,flow,names} = raw, count = f.length/5;
      const parent = r=>f[r*5+1], nm = r=>names[f[r*5]], part = r=>X.layout.partOfRow(i,r);
      for (let r = 0; r < count; r++) {
        if (f[r*5] !== nameId) continue;
        let inner = false;
        for (let p = parent(r); p >= 0 && flow.root[p] === flow.root[r] && !inner; p = parent(p)) inner = f[p*5] === nameId;
        if (inner) continue;
        const dur = f[r*5+3]/1000, async = flow.root[r] > 0;
        callers.part = callees.part = part(r);
        add(callers, dur, async);
        let c = callers;
        for (let p = parent(r); p >= 0 && flow.root[p] === flow.root[r]; p = parent(p)) { c = child(c,nm(p),part(p)); add(c,dur,async); }
        const origin = parent(flow.root[r]);
        if (origin >= 0) origins.add(nm(origin));
        add(callees,dur,async);
        const at = new Map([[r, callees]]);
        for (let q = r + 1; q < count && parent(q) >= r; q++) {
          let d;
          if (flow.start[q]) {
            const pathNames = [];
            for(let p=q; p>=r; p=parent(p)) pathNames.push(nm(p));
            const path = pathNames.reverse().join('\u0001');
            if (!flows.has(path)) flows.set(path, {key:path, origin:nm(parent(q)), tree:node(nm(q),part(q))});
            d = flows.get(path).tree;
          } else d = child(at.get(parent(q)), nm(q), part(q));
          add(d,f[q*5+3]/1000,flow.root[q]>0);
          at.set(q, d);
        }
      }
    }
    if (loaded < all) X.prefetchChunks();
    const value = { callers, callees, flows:[...flows.values()], origins:[...origins], loaded, all };
    focusCache = {key, value};
    return value;
  }

  X.spans = { init, render, pick, focusTree, invalidate() { lastKey = null; } };
})();
