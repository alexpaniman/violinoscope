// Changing which violins show. The + at the end of a column's children opens a list of what it has that is not
// shown, largest first, with a filter that looks through everything inside it: tick some and add them each as a
// violin, or as one merged violin under a name. Shift and a click on violins' names picks them; with two or more
// picked, a bar merges them. A × where the line meets the name of the violin under the pointer hides that violin; its
// parent still counts the time. A name carried onto another column shows what it will do; a double-click on a name
// types over it.
(function () {
  'use strict';
  const X = window.TX;
  const { $, esc, clamp } = X;

  let menu, bar, hideBtn, ghost;
  // Mode: null for the tree's + (what shows under it), or from a card, 'include' or 'exclude' (what its time is made of).
  let under = null, query = '', ticked = new Set(), naming = false, rows = [], mode = null;
  let replacement = null;
  X.picked = new Set();

  function init() {
    menu = $('v-add'); bar = $('v-merge'); hideBtn = $('v-hide');
    ghost = document.createElement('div');
    ghost.className = 'lift-ghost';
    ghost.hidden = true;
    $('violins').appendChild(ghost);
    menu.addEventListener('input', (e) => {
      if (!e.target.matches('[data-filter]')) return;
      query = e.target.value;
      naming = false;
      renderList();
    });
    menu.addEventListener('change', (e) => {
      if (e.target.matches('[data-all]')) {
        for (const r of rowsOf(e.target.dataset.all)) if (e.target.checked) ticked.add(r.id); else ticked.delete(r.id);
        renderList();
        return;
      }
      const box = e.target.closest('input[data-id]');
      if (!box) return;
      if(replacement)ticked.clear();
      if (box.checked) ticked.add(box.dataset.id); else ticked.delete(box.dataset.id);
      naming = false;
      renderFoot();
      syncAll();
    });
    menu.addEventListener('click', (e) => {
      const switchTo = e.target.closest('[data-mode]');
      if (switchTo) { mode = switchTo.dataset.mode; ticked = new Set(); renderHead(); renderList(); return; }
      const act = e.target.closest('[data-do]');
      if (!act) return;
      const ids = [...ticked], at = under;
      if(act.dataset.do==='replace') {
        const input={[mode]:ids[0]},index=replacement.index;
        try{X.layout.replaceInput(at,index,input);closeAdd();X.panel.renderCard();}catch(error){X.toast(error.message);}
        return;
      }
      if (act.dataset.do === 'apply') {
        closeAdd();
        if (mode === 'exclude') X.layout.exclude(at, ids);
        else { const id = X.layout.include(at, ids); if (id && id !== at) X.openCard(id, cardAt()); }
        return;
      }
      if (act.dataset.do === 'add') { closeAdd(); X.layout.add(ids, at); }
      else if (act.dataset.do === 'exclude') { closeAdd(); X.layout.exclude(at, ids); }
      else if (act.dataset.do === 'one') {
        if (ids.length < 2) { closeAdd(); X.layout.add(ids, at); return; }
        naming = true;
        renderFoot();
        const input = menu.querySelector('[data-name]');
        input.focus();
        input.select();
      } else if (act.dataset.do === 'merge') mergeTicked();
      else if (act.dataset.do === 'back') { naming = false; renderFoot(); }
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-name]')) { mergeTicked(); e.preventDefault(); }
      if (e.key === 'Escape') { closeAdd(); e.stopPropagation(); }
    });
    bar.addEventListener('click', (e) => {
      const act = e.target.closest('[data-do]');
      if (!act) return;
      if (act.dataset.do === 'merge') mergePicked(false);
      else if (act.dataset.do === 'parent') mergePicked(true);
      else if (act.dataset.do === 'above') { const span = X.layout.dominator([...X.picked]); X.picked.clear(); bar.hidden = true; if (span) X.layout.unskip(span); }
      else if (act.dataset.do === 'remove') removePicked();
      else { X.picked.clear(); syncBar(); X.violins.invalidate(); X.render(); }
    });
    bar.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-name]')) { mergePicked(false); e.preventDefault(); } });
    hideBtn.addEventListener('click', () => {
      const id = hideBtn.dataset.id;
      showHide(null);
      X.picked.delete(id);
      syncBar();
      X.layout.hide(id);
    });
    // A violin no longer shown can't stay picked; the × waits for the pointer to move to where the violins are now.
    X.on('layout', () => {
      hideBtn.hidden = true;
      for (const id of [...X.picked]) if (!X.data.columnIndex.has(id)) X.picked.delete(id);
      syncBar();
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The + list.

  // From a card, its spans: what to put into its time, or leave out of it.
  function openAdd(id, rect, what) {
    replacement=null;
    under = id;
    query = '';
    ticked = new Set();
    naming = false;
    mode = what || null;
    menu.innerHTML = '<div class="add-head"></div><div class="add-list" role="listbox" aria-multiselectable="true"></div><div class="add-foot"></div>';
    renderHead();
    // Below the +, or above it when there is more room there; no taller than that room, so its list scrolls and
    // its buttons stay on screen as it grows.
    // From a card, beside the card rather than over it.
    const stage = $('stage').getBoundingClientRect(), card = what ? $('card-pop').getBoundingClientRect() : null;
    const below = stage.bottom - rect.bottom - 18, above = rect.top - stage.top - 18;
    at = { rect, stage, card, up: !card && below < 320 && above > below };
    menu.style.maxHeight = `${Math.round(Math.min(440, card ? stage.height - 24 : Math.max(160, at.up ? above : below)))}px`;
    menu.hidden = false;
    renderList();
    menu.querySelector('[data-filter]').focus({ preventScroll: true });
  }
  function openInput(id,index,rect) {
    openAdd(id,rect,'include');replacement={index};mode='span';ticked=new Set();renderHead();renderList();
  }
  let at = null;
  function placeAdd() {
    if (!at || menu.hidden) return;
    const { rect, stage, card } = at, w = menu.offsetWidth, h = menu.offsetHeight;
    const right = card && card.right - stage.left + 8 + w <= stage.width - 12;
    const left = card ? (right ? card.right - stage.left + 8 : Math.max(12, card.left - stage.left - w - 8)) : clamp(rect.left - stage.left - 20, 12, stage.width - w - 12);
    const top = clamp(card ? rect.top - stage.top - 48 : at.up ? rect.top - stage.top - 6 - h : rect.bottom - stage.top + 6, 12, Math.max(12, stage.height - h - 12));
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function renderHead() {
    const where = under === X.ROOT2 ? `any span of ${X.UNIT}` : X.layout.label(under === X.ROOT ? X.layout.rootKey() : under);
    const find = mode === 'include' ? 'Find spans to include' : mode === 'exclude' ? `Find spans in ${where} to exclude` : `Find in ${where}`;
    const modes=replacement ? ['span','violin'] : ['include','exclude'];
    const seg = mode ? `<div class="seg add-mode" role="group" aria-label="Input type">${modes.map((m) => `<button type="button" data-mode="${m}" aria-pressed="${mode === m}">${{include:'Include',exclude:'Exclude',span:'Recorded span',violin:'Violin'}[m]}</button>`).join('')}</div>` : '';
    menu.querySelector('.add-head').innerHTML = `${seg}<input data-filter type="search" autocomplete="off" spellcheck="false" placeholder="${esc(find)}" aria-label="Find a span" value="${esc(query)}"><small class="add-scope"></small>`;
    menu.querySelector('[data-filter]').focus({ preventScroll: true });
  }
  // Where the card is, to open the card of what it became there.
  const cardAt = () => { const b = $('card-pop').getBoundingClientRect(); return { left: b.left, right: b.left, top: b.top, bottom: b.top }; };
  function closeAdd() {
    if (menu.hidden) return false;
    menu.hidden = true;
    under = null;
    return true;
  }
  // The tree's +: its children, then everything deeper under it, each section with an All of its own; a card's:
  // what to include or exclude.
  function renderList() {
    if(replacement) {
      rows=X.layout.inputChoices(under,mode,query);
      menu.querySelector('.add-scope').textContent=mode==='span' ? 'Use recorded coverage' : 'Follow this violin’s edits';
      menu.querySelector('.add-list').innerHTML=rows.map(r=>`<label class="add-row" title="${esc(r.where)}"><input type="radio" name="definition-input" data-id="${esc(r.id)}"${ticked.has(r.id)?' checked':''}><span class="nm">${esc(r.label)}<small>${esc(r.where)}</small></span></label>`).join('') || '<p class="add-none">No matching input.</p>';
      renderFoot();return;
    }
    rows = mode ? X.layout.spansFor(under, query, mode) : X.layout.candidates(under, query);
    const scope = menu.querySelector('.add-scope'), typed = !!query.trim();
    scope.textContent = mode === 'include' ? (typed ? `Any span of ${X.UNIT} not in it already` : '')
      : mode === 'exclude' ? (typed ? 'Every level inside it' : 'Its own children; type to look deeper') : '';
    const of = mode === 'include' ? X.UNIT : X.layout.label(under === X.ROOT ? X.layout.rootKey() : under);
    const row = (r) => `<label class="add-row" title="${esc(r.where ? `${r.where} › ${r.label}` : r.label)}">`
      + `<input type="checkbox" data-id="${esc(r.id)}"${ticked.has(r.id) ? ' checked' : ''}>`
      + `<span class="nm">${esc(r.label)}${r.group ? `<span class="count">${X.fmtInt(X.layout.size(r.id))}</span>` : ''}${r.where ? `<small>${esc(r.where)}</small>` : ''}</span>`
      + `<span class="pct" title="Its average share of ${esc(of)}'s time${r.seen < 0.995 ? `; present in ${X.fmtPct(r.seen)} of them` : ''}">${X.fmtPct(r.share)}${r.seen < 0.995 ? `<small>in ${X.fmtPct(r.seen)}</small>` : ''}</span></label>`;
    const section = (name, list, key) => (!list.length ? ''
      : `<div class="add-section"><label class="add-row all"><input type="checkbox" data-all="${key}"${list.every((r) => ticked.has(r.id)) ? ' checked' : ''}>`
        + `<span class="nm">${name}</span><span class="pct">All ${X.fmtInt(list.length)}</span></label>${list.map(row).join('')}</div>`);
    const list = menu.querySelector('.add-list');
    const html = mode ? section(mode === 'include' ? 'Spans' : 'Inside it', rows, 'all')
      : section(under === X.ROOT2 ? `Under ${esc(X.UNIT)}` : 'Its children', rows.filter((r) => !r.deep), 'kids')
        + section('Deeper inside', rows.filter((r) => r.deep), 'deep');
    list.innerHTML = html || `<p class="add-none">${mode === 'include' ? (typed ? 'No span not in it has that in its name.' : 'Type a span’s name to find it.')
      : mode === 'exclude' ? (typed ? 'Nothing inside it has that in its name.' : 'It calls nothing to exclude.')
        : typed ? 'Nothing not shown has that in its name.' : 'Everything inside it is shown.'}</p>`;
    renderFoot();
  }
  // The rows an All box stands for.
  const rowsOf = (key) => rows.filter((r) => key === 'all' || (key === 'deep') === !!r.deep);
  function syncAll() {
    for (const all of menu.querySelectorAll('[data-all]')) {
      const list = rowsOf(all.dataset.all);
      all.checked = list.length > 0 && list.every((r) => ticked.has(r.id));
    }
  }
  function renderFoot() {
    const foot = menu.querySelector('.add-foot'), n = ticked.size;
    if(replacement) {
      let preview='Choose an input',valid=false;
      if(n)try {
        const value=X.layout.previewInput(under,replacement.index,{[mode]:[...ticked][0]});
        const units=X.unitsInView(true),ids=[...units.left,...units.right],mean=values=>ids.length?ids.reduce((s,i)=>s+values[i],0)/ids.length:0;
        preview=`${X.fmtUs(mean(value.before))} → ${X.fmtUs(mean(value.after))} average`;valid=true;
      }catch(error){preview=error.message;}
      foot.innerHTML=`<span class="add-count">${esc(preview)}</span><button type="button" class="text-btn small primary" data-do="replace"${valid?'':' disabled'}>${replacement.index===X.layout.inputs(under).length?'Add':'Replace'}</button>`;placeAdd();return;
    }
    if (naming) {
      foot.innerHTML = `<button type="button" class="text-btn small" data-do="back" aria-label="Back">←</button>`
        + `<input data-name autocomplete="off" spellcheck="false" aria-label="Name of the merged violin" value="${esc(X.layout.suggestName([...ticked]))}">`
        + '<button type="button" class="text-btn small primary" data-do="merge">Add</button>';
      placeAdd();
      return;
    }
    if (mode) {
      const verb = mode === 'include' ? 'Include' : 'Exclude';
      foot.innerHTML = `<span class="add-count">${n ? `${X.fmtInt(n)} ticked` : `Tick what to ${verb.toLowerCase()}`}</span>`
        + `<button type="button" class="text-btn small primary" data-do="apply"${n ? '' : ' disabled'}>${verb}${n > 1 ? ` ${X.fmtInt(n)}` : ''}</button>`;
      placeAdd();
      return;
    }
    const violin = under !== X.ROOT && under !== X.ROOT2 && under !== X.layout.rootKey();
    foot.innerHTML = `<span class="add-count">${n ? `${X.fmtInt(n)} ticked` : 'Tick what to add'}</span>`
      + `<button type="button" class="text-btn small" data-do="add"${n ? '' : ' disabled'}>Add${n > 1 ? ` ${X.fmtInt(n)}` : ''}</button>`
      + `<button type="button" class="text-btn small" data-do="one"${n > 1 ? '' : ' disabled'} title="Add them as one violin: their time together">Add as one</button>`
      + (violin ? `<button type="button" class="text-btn small" data-do="exclude"${n ? '' : ' disabled'} title="Leave their time out of ${esc(X.layout.label(under))}">Exclude</button>` : '');
    placeAdd();
  }
  // Every match of a typed filter, merged, keeps the filter: spans read again that match it join.
  function mergeTicked() {
    const input = menu.querySelector('[data-name]'), ids = [...ticked];
    const all = query.trim() && rows.length > 1 && rows.every((r) => ticked.has(r.id)) && ticked.size === rows.length;
    const at = under;
    closeAdd();
    X.layout.merge(ids, input ? input.value : '', all ? { text: query.trim(), under: at === X.ROOT ? X.layout.rootKey() : at } : null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Picking shown violins to merge.

  function pick(id) {
    if (X.picked.has(id)) X.picked.delete(id); else X.picked.add(id);
    syncBar();
    X.violins.invalidate();
    X.render();
  }
  // Picked: removed together (Delete), or two or more merged under a name.
  function syncBar() {
    const ids = [...X.picked];
    if (!ids.length) { bar.hidden = true; return; }
    const name = bar.querySelector('[data-name]');
    const keep = name && document.activeElement === name ? name.value : null;
    const above = ids.length > 1 ? X.layout.dominator(ids) : null;
    bar.innerHTML = `<span>${ids.length === 1 ? '1 violin' : `${X.fmtInt(ids.length)} violins`} picked</span>`
      + (ids.length > 1 ? `<input data-name autocomplete="off" spellcheck="false" aria-label="Name of the merged violin" value="${esc(keep !== null ? keep : X.layout.suggestName(ids))}">`
        + '<button type="button" class="text-btn small primary" data-do="merge" title="One violin, their time together, closed">Merge</button>'
        + '<button type="button" class="text-btn small" data-do="parent" title="A merged violin above them, named so, with them still shown under it">New parent</button>'
        + (above ? `<button type="button" class="text-btn small promote" data-do="above" title="Put ${esc(X.layout.label(above))} back above them">Under ${esc(X.layout.label(above))}</button>` : '')
        : '<span class="spacer"></span>')
      + '<button type="button" class="text-btn small" data-do="remove" title="Hide these violins (Delete); their definitions and counted time stay">Hide</button>'
      + '<button type="button" class="chip-x" data-do="cancel" title="Let them go (Esc)" aria-label="Let them go">×</button>';
    bar.hidden = false;
    if (keep !== null) bar.querySelector('[data-name]').focus();
  }
  // Merged closed, or as a new parent with them shown under it.
  function mergePicked(parent) {
    const name = bar.querySelector('[data-name]').value, ids = [...X.picked];
    X.picked.clear();
    bar.hidden = true;
    X.layout.merge(ids, name, null, parent);
  }
  function removePicked() {
    const ids = [...X.picked];
    X.picked.clear();
    bar.hidden = true;
    if (ids.length) X.layout.remove(ids);
  }
  function clearPicked() {
    if (!X.picked.size) return false;
    X.picked.clear();
    syncBar();
    X.violins.invalidate();
    X.render();
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The × of the violin under the pointer, centred where its line meets its name, at (x, y) on the stage.

  function showHide(at) {
    if (!at) { if (!hideBtn.matches(':hover')) hideBtn.hidden = true; return; }
    hideBtn.dataset.id = at.id;
    hideBtn.title = X.layout.lifts(at.id) ? `Remove ${at.label}; what is under it moves up to ${X.layout.label(X.layout.parentOf(at.id))}`
      : `Remove ${at.label}: its parent still counts its time`;
    hideBtn.setAttribute('aria-label', `Remove ${at.label}`);
    hideBtn.style.transform = `translate(${Math.round(at.x - 8)}px, ${Math.round(at.y - 17)}px)`;
    hideBtn.hidden = false;
  }

  // A carried name by the pointer, and what dropping it does there.
  function showLift(name, px, py, onto, say) {
    if (name === null) { ghost.hidden = true; return; }
    const what = say || (onto === X.ROOT2 ? 'Copy it to Projections' : 'Drop it on a sibling to move it there');
    ghost.innerHTML = `<b>${esc(name)}</b><span>${esc(what)}</span>`;
    ghost.classList.toggle('off', onto === null && !say);
    ghost.style.transform = `translate(${Math.round(px + 14)}px, ${Math.round(py + 12)}px)`;
    ghost.hidden = false;
  }

  // Typing over a name, slanted as it is: Enter or a click away keeps it, Esc doesn't; a span's own name, or none,
  // gives it back.
  function rename(id) {
    const at = X.violins.nameAt(id);
    if (!at) return;
    const input = document.createElement('input');
    input.className = 'name-edit';
    input.value = X.layout.label(id);
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `New name for ${X.layout.label(id)}`);
    input.style.fontSize = `${at.size * at.z}px`;
    input.style.width = `${Math.round(Math.max(at.len + 48, 180) * at.z)}px`;
    input.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px) rotate(${at.deg}deg) translate(-100%, -5px)`;
    let keep = true;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); keep = false; input.blur(); }
    });
    input.addEventListener('blur', () => {
      input.remove();
      if (keep && input.value.trim() !== X.layout.label(id)) X.layout.rename(id, input.value);
    });
    $('violins').appendChild(input);
    input.focus({ preventScroll: true });
    input.select();
  }

  let moving = null;
  function openMove(id) {
    const options = X.layout.destinations(id), el = $('v-move');
    if (!options.length) return;
    closeAdd(); moving = id;
    const anchor = cardAt(), stage = $('stage').getBoundingClientRect(), card = $('card-pop').getBoundingClientRect();
    let selected = options[0].id;
    el.innerHTML = '<div class="add-head"><input type="search" data-move-find placeholder="Move to…" aria-label="Find a destination" autocomplete="off"><button type="button" class="quiet-btn" data-move-cancel aria-label="Close">×</button></div>'
      + '<div class="add-list" role="listbox" aria-label="Destinations"></div><p class="move-preview" data-move-preview></p>'
      + '<div class="add-foot"><span class="add-count"></span><button type="button" class="text-btn primary" data-move-apply>Move</button></div>';
    const input = el.querySelector('[data-move-find]');
    const place = () => {
      const w = el.offsetWidth, h = el.offsetHeight;
      const left = card.right - stage.left + 8 + w <= stage.width - 12 ? card.right - stage.left + 8 : card.left - stage.left - w - 8;
      el.style.transform = `translate(${Math.round(clamp(left,12,Math.max(12,stage.width-w-12)))}px, ${Math.round(clamp(card.top-stage.top,12,Math.max(12,stage.height-h-12)))}px)`;
    };
    const render = () => {
      const found = options.filter(d => d.label.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase()));
      if (!found.some(d => d.id === selected)) selected = found[0]?.id;
      el.querySelector('.add-list').innerHTML = found.map(d => `<button type="button" class="add-row move-choice" role="option" aria-selected="${d.id===selected}" data-move-target="${esc(d.id)}"><span class="nm">${esc(d.label)}</span></button>`).join('') || '<p class="add-none">No matching destination</p>';
      el.querySelector('[data-move-preview]').textContent = selected ? X.layout.transferPreview(id, selected) : '';
      el.querySelector('[data-move-apply]').disabled = !selected;
      el.querySelector('.add-count').textContent = X.layout.label(id);
      place();
    };
    const apply = () => {
      if (!selected) return;
      closeMove(); X.panel.closeCard();
      const out = X.layout.transfer(id, selected); if (out) X.openCard(out, anchor);
    };
    input.oninput = render;
    el.onclick = e => {
      if (e.target.closest('[data-move-cancel]')) closeMove();
      const row = e.target.closest('[data-move-target]');
      if (row) { selected = row.dataset.moveTarget; render(); }
      if (e.target.closest('[data-move-apply]')) apply();
    };
    el.onkeydown = e => {
      if (e.key === 'Escape') { closeMove(); e.stopPropagation(); }
      if (e.key === 'Enter' && e.target === input) { apply(); e.preventDefault(); }
      if (['ArrowDown','ArrowUp'].includes(e.key)) {
        const found = options.filter(d => d.label.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase()));
        const at = found.findIndex(d => d.id === selected), delta = e.key==='ArrowDown' ? 1 : -1;
        selected = found[Math.max(0,Math.min(found.length-1,at+delta))]?.id; render(); e.preventDefault();
      }
    };
    el.hidden = false; render(); input.focus({preventScroll:true});
  }
  function closeMove() { if (moving === null) return false; moving = null; $('v-move').hidden = true; return true; }

  X.edit = { openMove, closeMove, init, openAdd, openInput, closeAdd, pick, clearPicked, removePicked, showHide, showLift, rename, get open() { return !menu.hidden; } };
})();
