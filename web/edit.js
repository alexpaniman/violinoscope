// Changing which violins show. The + at the end of a column's children opens a list of what it has that is not
// shown, largest first, with a filter that looks through everything inside it: tick some and add them each as a
// violin, or as one merged violin under a name. Shift and a click on violins' names picks them; with two or more
// picked, a bar merges them. A × by the name under the pointer hides that violin; its parent still counts the time.
(function () {
  'use strict';
  const X = window.TX;
  const { $, esc, clamp } = X;

  let menu, bar, hideBtn;
  let under = null, query = '', ticked = new Set(), naming = false, rows = [];
  X.picked = new Set();

  function init() {
    menu = $('v-add'); bar = $('v-merge'); hideBtn = $('v-hide');
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
      const ids = [...ticked];
      if (act.dataset.do === 'add') { closeAdd(); X.layout.add(ids, under); }
      else if (act.dataset.do === 'one') {
        if (ids.length < 2) { closeAdd(); X.layout.add(ids, under); return; }
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
    // A violin no longer shown can't stay picked.
    X.on('layout', () => {
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
    menu.innerHTML = `<div class="add-head"><input data-filter type="search" autocomplete="off" spellcheck="false" placeholder="Find inside ${esc(X.layout.label(id === X.ROOT ? X.layout.rootKey() : id))}" aria-label="Find a span"></div>`
      + '<div class="add-list" role="listbox" aria-multiselectable="true"></div><div class="add-foot"></div>';
    menu.hidden = false;
    renderList();
    // Below the +, inside the stage.
    const stage = $('stage').getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    const left = clamp(rect.left - stage.left - 20, 12, stage.width - w - 12);
    const top = rect.bottom - stage.top + 6 + h < stage.height - 12 ? rect.bottom - stage.top + 6 : Math.max(12, rect.top - stage.top - 6 - h);
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    menu.querySelector('[data-filter]').focus({ preventScroll: true });
  }
  function closeAdd() {
    if (menu.hidden) return false;
    menu.hidden = true;
    under = null;
    return true;
  }
  function renderList() {
    rows = X.layout.candidates(under, query);
    const list = menu.querySelector('.add-list');
    const head = query.trim() && rows.length > 1
      ? `<label class="add-row all"><input type="checkbox" data-all${rows.every((r) => ticked.has(r.id)) ? ' checked' : ''}><span class="nm">All ${X.fmtInt(rows.length)}</span></label>` : '';
    list.innerHTML = rows.length ? head + rows.map((r) => `<label class="add-row" title="${esc(r.where ? `${r.where} › ${r.label}` : r.label)}">`
      + `<input type="checkbox" data-id="${esc(r.id)}"${ticked.has(r.id) ? ' checked' : ''}>`
      + `<span class="nm${r.group ? ' merged' : ''}">${esc(r.label)}${r.where ? `<small>${esc(r.where)}</small>` : ''}</span>`
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
      return;
    }
    foot.innerHTML = `<span class="add-count">${n ? `${X.fmtInt(n)} ticked` : 'Tick what to add'}</span>`
      + `<button type="button" class="text-btn small" data-do="add"${n ? '' : ' disabled'}>Add${n > 1 ? ` ${X.fmtInt(n)}` : ''}</button>`
      + `<button type="button" class="text-btn small" data-do="one"${n > 1 ? '' : ' disabled'} title="Add them as one violin: their time together">Add as one</button>`;
  }
  function mergeTicked() {
    const input = menu.querySelector('[data-name]'), ids = [...ticked];
    closeAdd();
    X.layout.merge(ids, input ? input.value : '');
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
  // The × by the name under the pointer, at (x, y) on the stage: where the slanted name starts.

  function showHide(at) {
    if (!at) { if (!hideBtn.matches(':hover')) hideBtn.hidden = true; return; }
    hideBtn.dataset.id = at.id;
    hideBtn.title = `Hide ${at.label}: its parent still counts its time`;
    hideBtn.setAttribute('aria-label', `Hide ${at.label}`);
    hideBtn.style.transform = `translate(${Math.round(at.x + 4)}px, ${Math.round(at.y - 2)}px)`;
    hideBtn.hidden = false;
  }

  X.edit = { init, openAdd, closeAdd, pick, clearPicked, showHide, get open() { return !menu.hidden; } };
})();
