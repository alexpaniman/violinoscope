// Sharing the violins, from the Layout button. On claude.ai, whoever can edit the page saves them into it, and
// everyone who opens it starts with them. Anywhere else, a link carries them: a page opened from disk or served from
// a folder opens with the violins in its address. And back to where everyone starts.
(function () {
  'use strict';
  const X = window.TX;
  const { $, esc, clamp } = X;

  let btn, menu;
  // The page's own artifact, when it is one and this view can run it; whether the viewer may save, and why not.
  let artifact = null, canSave = false, note = '', busy = false, shown = '';

  function init() {
    btn = $('layout-btn'); menu = $('layout-menu');
    btn.addEventListener('click', () => (menu.hidden ? open() : close()));
    menu.addEventListener('click', (e) => {
      const act = e.target.closest('[data-do]');
      if (!act || act.disabled) return;
      if (act.dataset.do === 'save') save();
      else if (act.dataset.do === 'link') copyLink();
      else if (act.dataset.do === 'reset') { close(); X.layout.reset(); }
    });
    const claude = window.claude;
    if (!claude || typeof claude.use !== 'function') return;
    claude.use('artifact').then(async (a) => {
      if (!a) return;
      artifact = a;
      const user = await claude.use('user').catch(() => null);
      canSave = user ? await user.canEdit() : true;
      if (!canSave) note = 'Only people who can edit this page can save it';
      if (!menu.hidden) render();
    }).catch(() => {});
  }

  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function render() {
    const saved = X.layout.saved, items = [];
    if (artifact) {
      const sub = note || (saved ? `Everyone starts with them; last saved ${when(saved.saved)}` : 'Everyone who opens this page starts with them');
      items.push(`<button type="button" data-do="save"${canSave && !busy ? '' : ' disabled'}>${busy ? 'Saving…' : 'Save for everyone'}<small>${esc(sub)}</small></button>`);
    }
    // Framed on claude.ai, the page's own address is not the one people open.
    if (!window.claude) {
      items.push(`<button type="button" data-do="link">Copy link<small>Opens these violins, wherever this page is</small></button>`);
      if (shown) items.push(`<input class="layout-link" readonly aria-label="Link that opens these violins" value="${esc(shown)}">`);
    }
    items.push(saved ? `<button type="button" data-do="reset">Back to the saved violins<small>As saved ${esc(when(saved.saved))}</small></button>`
      : `<button type="button" data-do="reset">Start over<small>${esc(X.UNIT)} and the spans that take most of its time</small></button>`);
    menu.innerHTML = items.join('');
    const link = menu.querySelector('.layout-link');
    if (link) { link.focus(); link.select(); }
  }
  function open() {
    shown = '';
    render();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const stage = $('stage').getBoundingClientRect(), r = btn.getBoundingClientRect(), w = menu.offsetWidth;
    menu.style.transform = `translate(${Math.round(clamp(r.left - stage.left, 12, stage.width - w - 12))}px, ${Math.round(r.bottom - stage.top + 6)}px)`;
  }
  function close() {
    if (!menu || menu.hidden) return false;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return true;
  }

  async function copyLink() {
    const url = await X.layout.link();
    try {
      await navigator.clipboard.writeText(url);
      close();
      X.toast('Link copied: it opens these violins');
    } catch (e) {
      // No clipboard here: the link to copy by hand.
      shown = url;
      render();
    }
  }

  async function save() {
    const doc = { saved: new Date().toISOString(), unit: X.UNIT, layout: X.layout.state() };
    busy = true;
    note = '';
    render();
    try {
      await artifact.publish({ 'data/layout.js': { content: `window.EXPLORER_LAYOUT = ${JSON.stringify(doc)};\n`, contentType: 'text/javascript' } });
      X.layout.savedAs(doc);
      busy = false;
      close();
      X.toast('Saved: everyone who opens this page starts with these violins');
      return;
    } catch (err) {
      const code = err && err.code;
      if (code === 'conflict') note = 'Someone saved the page just now; it is loading their version';
      else if (code === 'not_writer' || code === 'not_granted' || code === 'consent_required') { canSave = false; note = 'Only people who can edit this page can save it'; }
      else if (code === 'capability_disabled' || code === 'capability_removed') { canSave = false; note = 'This page can’t save itself here, for example once it is shared publicly'; }
      else if (code === 'rate_limited') note = 'Saved too often; try again in a minute';
      else note = 'Couldn’t save; try again';
    }
    busy = false;
    if (!menu.hidden) render();
  }

  X.share = { init, close };
})();
