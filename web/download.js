// The download icon: this page as one HTML file, data and all, opening with the violins as they are now. On claude.ai
// the viewer confirms where it goes; anywhere else it downloads. The page's own scripts and styles are inside it
// (script[data-v], style[data-v]), and its data is what it has read, so it works opened from disk too.
(function () {
  'use strict';
  const X = window.TX;
  const { $, esc } = X;
  // The page before anything ran, to build the file from.
  const markup = document.getElementById('app').outerHTML;
  let btn;

  function init() {
    btn = $('download');
    btn.addEventListener('click', download);
    const ready = () => { btn.disabled = !X.layout.ready; };
    X.on('layout', ready);
    ready();
  }

  // Nothing in a script may end it early.
  const inScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
  function build() {
    const doc = { saved: new Date().toISOString(), unit: X.UNIT, layout: X.layout.state() };
    const head = ['<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<style>[hidden]{display:none!important}body{margin:0}</style>', `<title>${esc(document.title)}</title>`];
    for (const link of document.querySelectorAll('link[href^="https://fonts."]')) head.push(link.outerHTML);
    for (const style of document.querySelectorAll('style[data-v]')) head.push(`<style data-v>${style.textContent}</style>`);
    const parts = [head.join('\n'), '\n</head><body>\n', markup, '\n',
      `<script>window.EXPLORER_SUMMARY=${inScript(X.summaryText)};</script>\n`,
      `<script>window.EXPLORER_LAYOUT=${inScript(JSON.stringify(doc))};</script>\n`];
    for (let k = 0; k < X.chunkCount; k++) {
      parts.push(`<script>(window.EXPLORER_CHUNKS=window.EXPLORER_CHUNKS||{})[${k}]=${inScript(JSON.stringify(X.chunk(k)))};</script>\n`);
    }
    for (const s of document.querySelectorAll('script[data-v]')) parts.push(`<script data-v="${esc(s.dataset.v)}">${inScript(s.text)}</script>\n`);
    parts.push('</body></html>\n');
    return new Blob(parts, { type: 'text/html' });
  }

  async function download() {
    if (!X.layout.ready) return;
    const blob = build(), name = `${(X.meta.title || X.UNIT).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'violinoscope'}.html`;
    const claude = window.claude;
    const saver = claude && typeof claude.use === 'function' ? await claude.use('downloads').catch(() => null) : null;
    if (saver) {
      try { await saver.save({ filename: name, data: blob }); } catch (e) {
        if (e && e.code !== 'declined') X.toast('This page can’t save files here');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  X.download = { init, build };
})();
