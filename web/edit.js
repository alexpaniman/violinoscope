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
  let under = null, query = '', ticked = new Set(), naming = false, rows = [];
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
        for (const r of rows) if (e.target.checked) ticked.add(r.id); else ticked.delete(r.id);
        renderList();
        return;
      }
      const box = e.target.closest('input[data-id]');
      if (!box) return;
      if (box.checked) ticked.add(box.dataset.id); else ticked.delete(box.dataset.id);
      naming = false;
      renderFoot();
      syncAll();
    });
    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-do]');
      if (!act) return;
      const ids = [...ticked], at = under;
      if (act.dataset.do === 'add') { closeAdd(); X.layout.add(ids, at); }
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
      if (act.dataset.do === 'merge') mergePicked();
      else { X.picked.clear(); syncBar(); X.violins.invalidate(); X.render(); }
    });
    bar.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-name]')) { mergePicked(); e.preventDefault(); } });
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

  function openAdd(id, rect) {
    under = id;
    query = '';
    ticked = new Set();
    naming = false;
    const where = id === X.ROOT2 ? `any span of ${X.UNIT}` : X.layout.label(id === X.ROOT ? X.layout.rootKey() : id);
    menu.innerHTML = `<div class="add-head"><input data-filter type="search" autocomplete="off" spellcheck="false" placeholder="Find in ${esc(where)}" aria-label="Find a span"><small class="add-scope"></small></div>`
      + '<div class="add-list" role="listbox" aria-multiselectable="true"></div><div class="add-foot"></div>';
    // Below the +, or above it when there is more room there; no taller than that room, so its list scrolls and
    // its buttons stay on screen as it grows.
    const stage = $('stage').getBoundingClientRect();
    const below = stage.bottom - rect.bottom - 18, above = rect.top - stage.top - 18;
    at = { rect, stage, up: below < 320 && above > below };
    menu.style.maxHeight = `${Math.round(Math.min(440, Math.max(160, at.up ? above : below)))}px`;
    menu.hidden = false;
    renderList();
    menu.querySelector('[data-filter]').focus({ preventScroll: true });
  }
  let at = null;
  function placeAdd() {
    if (!at || menu.hidden) return;
    const { rect, stage } = at, w = menu.offsetWidth, h = menu.offsetHeight;
    const left = clamp(rect.left - stage.left - 20, 12, stage.width - w - 12);
    const top = clamp(at.up ? rect.top - stage.top - 6 - h : rect.bottom - stage.top + 6, 12, Math.max(12, stage.height - h - 12));
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function closeAdd() {
    if (menu.hidden) return false;
    menu.hidden = true;
    under = null;
    return true;
  }
  function renderList() {
    rows = X.layout.candidates(under, query);
    // Typed, the list looks through every level, not only the violin's own children.
    const scope = menu.querySelector('.add-scope');
    scope.textContent = !query.trim() ? '' : under === X.ROOT2 ? `Every level of ${X.UNIT}` : `Every level inside ${X.layout.label(under === X.ROOT ? X.layout.rootKey() : under)}`;
    const list = menu.querySelector('.add-list');
    const head = query.trim() && rows.length > 1
      ? `<label class="add-row all"><input type="checkbox" data-all${rows.every((r) => ticked.has(r.id)) ? ' checked' : ''}><span class="nm">All ${X.fmtInt(rows.length)}</span></label>` : '';
    list.innerHTML = rows.length ? head + rows.map((r) => `<label class="add-row" title="${esc(r.where ? `${r.where} › ${r.label}` : r.label)}">`
      + `<input type="checkbox" data-id="${esc(r.id)}"${ticked.has(r.id) ? ' checked' : ''}>`
      + `<span class="nm">${esc(r.label)}${r.group ? `<span class="count">${X.fmtInt(X.layout.size(r.id))}</span>` : ''}${r.where ? `<small>${esc(r.where)}</small>` : ''}</span>`
      + `<span class="pct" title="Its average share of ${esc(X.layout.label(under === X.ROOT ? X.layout.rootKey() : under))}'s time${r.seen < 0.995 ? `; present in ${X.fmtPct(r.seen)} of them` : ''}">${X.fmtPct(r.share)}${r.seen < 0.995 ? `<small>in ${X.fmtPct(r.seen)}</small>` : ''}</span></label>`).join('')
      : `<p class="add-none">${query.trim() ? 'Nothing not shown has that in its name.' : 'Everything inside it is shown.'}</p>`;
    renderFoot();
  }
  function syncAll() {
    const all = menu.querySelector('[data-all]');
    if (all) all.checked = rows.length > 0 && rows.every((r) => ticked.has(r.id));
  }
  function renderFoot() {
    const foot = menu.querySelector('.add-foot'), n = ticked.size;
    if (naming) {
      foot.innerHTML = `<button type="button" class="text-btn small" data-do="back" aria-label="Back">←</button>`
        + `<input data-name autocomplete="off" spellcheck="false" aria-label="Name of the merged violin" value="${esc(X.layout.suggestName([...ticked]))}">`
        + '<button type="button" class="text-btn small primary" data-do="merge">Add</button>';
      placeAdd();
      return;
    }
    foot.innerHTML = `<span class="add-count">${n ? `${X.fmtInt(n)} ticked` : 'Tick what to add'}</span>`
      + `<button type="button" class="text-btn small" data-do="add"${n ? '' : ' disabled'}>Add${n > 1 ? ` ${X.fmtInt(n)}` : ''}</button>`
      + `<button type="button" class="text-btn small" data-do="one"${n > 1 ? '' : ' disabled'} title="Add them as one violin: their time together">Add as one</button>`;
    placeAdd();
  }
  // Every match of a typed filter, merged, keeps the filter: spans read again that match it join.
  function mergeTicked() {
    const input = menu.querySelector('[data-name]'), ids = [...ticked];
    const all = query.trim() && rows.length > 1 && rows.every((r) => ticked.has(r.id)) && ticked.size === rows.length;
    const at = under;
    closeAdd();
    X.layout.merge(ids, input ? input.value : '', null, all ? { text: query.trim(), under: at === X.ROOT ? X.layout.rootKey() : at } : null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Picking shown violins to merge.

  function pick(id) {
    if (X.picked.has(id)) X.picked.delete(id); else X.picked.add(id);
    syncBar();
    X.violins.invalidate();
    X.render();
  }
  function syncBar() {
    const ids = [...X.picked];
    if (ids.length < 2) { bar.hidden = true; return; }
    const name = bar.querySelector('[data-name]');
    const keep = name && document.activeElement === name ? name.value : null;
    bar.innerHTML = `<span>${X.fmtInt(ids.length)} violins picked</span>`
      + `<input data-name autocomplete="off" spellcheck="false" aria-label="Name of the merged violin" value="${esc(keep !== null ? keep : X.layout.suggestName(ids))}">`
      + '<button type="button" class="text-btn small primary" data-do="merge">Merge</button>'
      + '<button type="button" class="chip-x" data-do="cancel" title="Let them go (Esc)" aria-label="Let them go">×</button>';
    bar.hidden = false;
    if (keep !== null) bar.querySelector('[data-name]').focus();
  }
  function mergePicked() {
    const name = bar.querySelector('[data-name]').value, ids = [...X.picked];
    X.picked.clear();
    bar.hidden = true;
    X.layout.merge(ids, name);
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
    hideBtn.title = `Hide ${at.label}: its parent still counts its time`;
    hideBtn.setAttribute('aria-label', `Hide ${at.label}`);
    hideBtn.style.transform = `translate(${Math.round(at.x - 8)}px, ${Math.round(at.y - 17)}px)`;
    hideBtn.hidden = false;
  }

  // A carried name by the pointer, and what dropping it does there.
  function showLift(name, px, py, onto) {
    if (name === null) { ghost.hidden = true; return; }
    const what = onto === null ? 'Drop it on another violin to merge them' : onto === X.ROOT2 ? 'Copy it to Projections'
      : `${X.layout.isMerged(onto) ? 'Add to' : 'Merge with'} ${X.layout.label(onto)}`;
    ghost.innerHTML = `<b>${esc(name)}</b><span>${esc(what)}</span>`;
    ghost.classList.toggle('off', onto === null);
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

  X.edit = { init, openAdd, closeAdd, pick, clearPicked, showHide, showLift, rename, get open() { return !menu.hidden; } };
})();
