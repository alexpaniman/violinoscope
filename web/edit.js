// Tree edits: name selectors, hidden configured nodes, grouping and movement.
(function () {
  'use strict';
  const X = window.TX,
    { $, esc, clamp } = X;
  let menu,
    bar,
    hideBtn,
    controls,
    ghost,
    under = null,
    query = '',
    ticked = new Set(),
    rows = [],
    mode = 'spans',
    at = null;
  X.picked = new Set();
  const safely = (fn) => {
    try {
      return fn();
    } catch (error) {
      X.toast(error.message);
    }
  };
  function init() {
    menu = $('v-add');
    bar = $('v-merge');
    hideBtn = $('v-hide');
    controls = document.createElement('div');
    controls.className = 'tree-actions';
    controls.id = 'v-actions';
    controls.hidden = true;
    hideBtn.replaceWith(controls);
    controls.appendChild(hideBtn);
    hideBtn.hidden = false;
    controls.insertAdjacentHTML(
      'beforeend',
      '<button type="button" class="quiet-btn" data-hide-node title="Hide, keeping its share" aria-label="Hide violin">◌</button>',
    );
    ghost = document.createElement('div');
    ghost.className = 'lift-ghost';
    ghost.hidden = true;
    $('violins').appendChild(ghost);
    menu.oninput = (e) => {
      if (e.target.matches('[data-filter]')) {
        query = e.target.value;
        renderList();
      }
    };
    menu.onchange = (e) => {
      if (e.target.matches('[data-all]')) {
        for (const r of rows)
          if (e.target.checked) ticked.add(r.id);
          else ticked.delete(r.id);
        renderList();
        return;
      }
      const box = e.target.closest('[data-id]');
      if (box) {
        if (box.checked) ticked.add(box.dataset.id);
        else ticked.delete(box.dataset.id);
        renderFoot();
      }
    };
    menu.onclick = (e) => {
      const tab = e.target.closest('[data-mode]');
      if (tab) {
        mode = tab.dataset.mode;
        ticked.clear();
        renderHead();
        renderList();
        return;
      }
      const action = e.target.closest('[data-do]')?.dataset.do;
      if (!action) return;
      const ids = [...ticked],
        parent = under;
      if (action === 'add')
        safely(() => {
          X.layout.add(ids, parent);
          closeAdd();
        });
      if (action === 'one')
        safely(() => {
          X.layout.addGroup(ids, parent, menu.querySelector('[data-name]')?.value || X.layout.suggestName(ids));
          closeAdd();
        });
    };
    menu.onkeydown = (e) => {
      if (e.key === 'Escape') {
        closeAdd();
        e.stopPropagation();
      }
      if (e.key === 'Enter' && e.target.matches('[data-name]')) {
        menu.querySelector('[data-do="one"]').click();
        e.preventDefault();
      }
    };
    controls.onclick = (e) => {
      const id = hideBtn.dataset.id;
      showHide(null, true);
      safely(() => (e.target.closest('[data-hide-node]') ? X.layout.hide(id) : X.layout.remove([id])));
    };
    bar.onclick = (e) => {
      const action = e.target.closest('[data-do]')?.dataset.do;
      if (action === 'merge')
        safely(() => {
          X.layout.merge([...X.picked], bar.querySelector('[data-name]').value);
          clearPicked();
        });
      else if (action === 'remove') removePicked();
      else if (action === 'cancel') clearPicked();
    };
    X.on('layout', () => {
      controls.hidden = true;
      for (const id of [...X.picked]) if (!X.layout.shown(id)) X.picked.delete(id);
      syncBar();
    });
  }
  function openAdd(id, rect, what) {
    under = id;
    query = '';
    ticked.clear();
    mode = what === 'hidden' ? 'hidden' : 'spans';
    menu.innerHTML =
      '<div class="add-head"></div><div class="add-list" role="listbox" aria-multiselectable="true"></div><div class="add-foot"></div>';
    const stage = $('stage').getBoundingClientRect(),
      below = stage.bottom - rect.bottom - 18,
      above = rect.top - stage.top - 18;
    at = { rect, stage, up: below < 320 && above > below };
    menu.style.maxHeight = `${Math.round(Math.min(440, Math.max(180, at.up ? above : below)))}px`;
    menu.hidden = false;
    renderHead();
    renderList();
    menu.querySelector('[data-filter]').focus({ preventScroll: true });
  }
  function openHidden(ids, rect) {
    openAdd(X.layout.modelParent(ids[0]), rect, 'hidden');
    rows = ids.map((id) => ({ id, label: X.layout.label(id), share: NaN, seen: 1 }));
    // Intermediate ancestors are restored without altering their children or calculation.
    menu.dataset.ancestors = JSON.stringify(ids);
    renderList();
  }
  function placeAdd() {
    if (!at || menu.hidden) return;
    const { rect, stage } = at,
      w = menu.offsetWidth,
      h = menu.offsetHeight;
    const left = clamp(rect.left - stage.left - 20, 12, Math.max(12, stage.width - w - 12)),
      top = clamp(
        at.up ? rect.top - stage.top - 6 - h : rect.bottom - stage.top + 6,
        12,
        Math.max(12, stage.height - h - 12),
      );
    menu.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }
  function renderHead() {
    menu.querySelector('.add-head').innerHTML =
      `<div class="seg add-mode" role="group" aria-label="Add or reveal"><button type="button" data-mode="spans" aria-pressed="${mode === 'spans'}">Spans</button><button type="button" data-mode="hidden" aria-pressed="${mode === 'hidden'}">Hidden</button></div><input data-filter type="search" autocomplete="off" spellcheck="false" placeholder="Find in ${esc(X.layout.label(under))}" aria-label="Find a span" value="${esc(query)}">`;
  }
  function closeAdd() {
    if (menu.hidden) return false;
    menu.hidden = true;
    delete menu.dataset.ancestors;
    under = null;
    return true;
  }
  function renderList() {
    rows = mode === 'hidden' ? X.layout.hiddenCandidates(under, query) : X.layout.candidates(under, query);
    if (mode === 'hidden' && menu.dataset.ancestors)
      rows = JSON.parse(menu.dataset.ancestors)
        .filter((id) => X.layout.label(id).toLowerCase().includes(query.toLowerCase()))
        .map((id) => ({ id, label: X.layout.label(id) }));
    menu.querySelector('.add-list').innerHTML = rows.length
      ? `<label class="add-row all"><input type="checkbox" data-all ${rows.every((r) => ticked.has(r.id)) ? 'checked' : ''}><span class="nm">All</span><span class="pct">${rows.length}</span></label>` +
        rows
          .map(
            (r) =>
              `<label class="add-row"><input type="checkbox" data-id="${esc(r.id)}"${ticked.has(r.id) ? ' checked' : ''}><span class="nm">${r.group ? '<span class="group-mark">⊞</span>' : ''}${esc(r.label)}</span><span class="pct">${Number.isFinite(r.share) ? X.fmtPct(r.share) : ''}</span></label>`,
          )
          .join('')
      : `<p class="add-none">${query ? 'No matches' : mode === 'hidden' ? 'Nothing hidden here' : 'No further spans in this scope'}</p>`;
    renderFoot();
  }
  function renderFoot() {
    const n = ticked.size;
    menu.querySelector('.add-foot').innerHTML =
      `<span class="add-count">${n ? `${n} selected` : ''}</span><button type="button" class="text-btn small primary" data-do="add"${n ? '' : ' disabled'}>${mode === 'hidden' ? 'Reveal' : 'Add'}</button>` +
      (mode === 'spans' && n > 1 ? '<button type="button" class="text-btn small" data-do="one">Group</button>' : '');
    placeAdd();
  }
  function pick(id) {
    if (X.layout.isRest(id)) return;
    if (X.picked.has(id)) X.picked.delete(id);
    else X.picked.add(id);
    syncBar();
    X.violins.invalidate();
    X.render();
  }
  function syncBar() {
    const ids = [...X.picked];
    if (!ids.length) {
      bar.hidden = true;
      return;
    }
    bar.innerHTML = `<span>${ids.length} selected</span><input data-name aria-label="Group name" value="${esc(X.layout.suggestName(ids))}"><button class="text-btn small" data-do="merge">Group</button><button class="text-btn small" data-do="remove">Delete</button><button class="quiet-btn" data-do="cancel" aria-label="Clear selection">×</button>`;
    bar.hidden = false;
  }
  function removePicked() {
    const ids = [...X.picked];
    safely(() => X.layout.remove(ids));
    clearPicked();
  }
  function clearPicked() {
    if (!X.picked.size) return false;
    X.picked.clear();
    syncBar();
    X.violins.invalidate();
    X.render();
    return true;
  }
  function showHide(at, force = false) {
    if (!at) {
      if (force || !controls.matches(':hover')) controls.hidden = true;
      return;
    }
    hideBtn.dataset.id = at.id;
    hideBtn.title = X.layout.lifts(at.id) ? 'Dissolve group; keep its base members' : 'Delete this subtree';
    hideBtn.setAttribute('aria-label', `Delete ${at.label}`);
    hideBtn.style.transform = 'none';
    hideBtn.style.position = 'static';
    hideBtn.hidden = X.layout.isRest(at.id);
    controls.style.transform = `translate(${Math.round(at.x - 9)}px,${Math.round(at.y - 18)}px)`;
    controls.hidden = false;
  }
  function showLift(name, px, py, onto, say) {
    if (name === null) {
      ghost.hidden = true;
      return;
    }
    ghost.innerHTML = `<b>${esc(name)}</b><span>${esc(say || 'Choose a destination')}</span>`;
    ghost.classList.toggle('off', onto === null && !say);
    ghost.style.transform = `translate(${Math.round(px + 14)}px,${Math.round(py + 12)}px)`;
    ghost.hidden = false;
  }
  const cardAt = () => {
    const b = $('card-pop').getBoundingClientRect();
    return { left: b.left, right: b.left, top: b.top, bottom: b.top };
  };
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
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        keep = false;
        input.blur();
      }
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
    const options = X.layout.destinations(id),
      el = $('v-move');
    if (!options.length) return;
    closeAdd();
    moving = id;
    const anchor = cardAt(),
      stage = $('stage').getBoundingClientRect(),
      card = $('card-pop').getBoundingClientRect();
    let selected = options[0].id;
    el.innerHTML =
      '<div class="add-head"><input type="search" data-move-find placeholder="Move to…" aria-label="Find a destination" autocomplete="off"><button type="button" class="quiet-btn" data-move-cancel aria-label="Close">×</button></div>' +
      '<div class="add-list" role="listbox" aria-label="Destinations"></div><p class="move-preview" data-move-preview></p>' +
      '<div class="add-foot"><span class="add-count"></span><button type="button" class="text-btn primary" data-move-apply>Move</button></div>';
    const input = el.querySelector('[data-move-find]');
    const place = () => {
      const w = el.offsetWidth,
        h = el.offsetHeight;
      const left =
        card.right - stage.left + 8 + w <= stage.width - 12
          ? card.right - stage.left + 8
          : card.left - stage.left - w - 8;
      el.style.transform = `translate(${Math.round(clamp(left, 12, Math.max(12, stage.width - w - 12)))}px, ${Math.round(clamp(card.top - stage.top, 12, Math.max(12, stage.height - h - 12)))}px)`;
    };
    const render = () => {
      const found = options.filter((d) => d.label.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase()));
      if (!found.some((d) => d.id === selected)) selected = found[0]?.id;
      el.querySelector('.add-list').innerHTML =
        found
          .map(
            (d) =>
              `<button type="button" class="add-row move-choice" role="option" aria-selected="${d.id === selected}" data-move-target="${esc(d.id)}"><span class="nm">${esc(d.label)}</span></button>`,
          )
          .join('') || '<p class="add-none">No matching destination</p>';
      el.querySelector('[data-move-preview]').textContent = selected ? X.layout.transferPreview(id, selected) : '';
      el.querySelector('[data-move-apply]').disabled = !selected;
      el.querySelector('.add-count').textContent = X.layout.label(id);
      place();
    };
    const apply = () => {
      if (!selected) return;
      closeMove();
      X.panel.closeCard();
      safely(() => {
        const out = X.layout.transfer(id, selected);
        if (out) X.openCard(out, anchor);
      });
    };
    input.oninput = render;
    el.onclick = (e) => {
      if (e.target.closest('[data-move-cancel]')) closeMove();
      const row = e.target.closest('[data-move-target]');
      if (row) {
        selected = row.dataset.moveTarget;
        render();
      }
      if (e.target.closest('[data-move-apply]')) apply();
    };
    el.onkeydown = (e) => {
      if (e.key === 'Escape') {
        closeMove();
        e.stopPropagation();
      }
      if (e.key === 'Enter' && e.target === input) {
        apply();
        e.preventDefault();
      }
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        const found = options.filter((d) =>
          d.label.toLocaleLowerCase().includes(input.value.trim().toLocaleLowerCase()),
        );
        const at = found.findIndex((d) => d.id === selected),
          delta = e.key === 'ArrowDown' ? 1 : -1;
        selected = found[Math.max(0, Math.min(found.length - 1, at + delta))]?.id;
        render();
        e.preventDefault();
      }
    };
    el.hidden = false;
    render();
    input.focus({ preventScroll: true });
  }
  function closeMove() {
    if (moving === null) return false;
    moving = null;
    $('v-move').hidden = true;
    return true;
  }

  X.edit = {
    openMove,
    closeMove,
    init,
    openAdd,
    openHidden,
    closeAdd,
    pick,
    clearPicked,
    removePicked,
    showHide,
    showLift,
    rename,
    get open() {
      return !menu.hidden;
    },
  };
})();
