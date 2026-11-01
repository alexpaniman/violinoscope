// Export the current layout as an offline page or a PNG with its title and key.
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
    $('picture').title = 'Copy picture · Shift-click to download';
    $('picture').addEventListener('click', e => { picture(e.shiftKey).catch(() => X.toast('Couldn’t draw the picture')); });
    const ready = () => { btn.disabled = !X.layout.ready; $('picture').disabled = !X.layout.ready; };
    X.on('layout', ready);
    ready();
  }

  // Nothing in a script may end it early.
  const inScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1');
  async function build() {
    const doc = { saved: new Date().toISOString(), ...(X.layouts ? X.layouts.current() : {unit:X.UNIT,layout:X.layout.state()}) };
    const head = ['<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
      '<style>[hidden]{display:none!important}body{margin:0}</style>', `<title>${esc(document.title)}</title>`];
    for (const link of document.querySelectorAll('link[href^="https://fonts."]')) head.push(link.outerHTML);
    for (const style of document.querySelectorAll('style[data-v]')) head.push(`<style data-v>${style.textContent}</style>`);
    const parts = [head.join('\n'), '\n</head><body>\n', markup, '\n',
      `<script>window.EXPLORER_SUMMARY=${inScript(X.summaryText)};</script>\n`,
      `<script>window.EXPLORER_LAYOUT=${inScript(JSON.stringify(doc))};</script>\n`];
    for (let k = 0; k < X.chunkCount; k++) {
      const stream = new Blob([JSON.stringify(X.chunk(k))]).stream().pipeThrough(new CompressionStream('gzip'));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      let binary = '';
      for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
      parts.push(`<script type="application/octet-stream" data-chunk="${k}" data-gzip>${btoa(binary)}</script>\n`);
    }
    for (const s of document.querySelectorAll('script[data-v]')) parts.push(`<script data-v="${esc(s.dataset.v)}">${inScript(s.text)}</script>\n`);
    parts.push('</body></html>\n');
    return new Blob(parts, { type: 'text/html' });
  }

  const fileName = (ext) => `${(X.meta.title || X.UNIT).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'violinoscope'}.${ext}`;
  async function download() {
    if (!X.layout.ready) return;
    await save(await build(), fileName('html'));
  }

  // The figure as it shows, from the plot's top to the strips' bottom and as wide as its columns, at three times the size;
  // above it the title and which groups each half and mark is. Its layers drawn in order: shapes, dots, the tree and
  // labels, the strips.
  async function picture(downloadFile = false) {
    const G = X.violins.G;
    if (!G || !X.layout.ready) return;
    const view = $('violins'), box = view.getBoundingClientRect(), T = X.T, k = 3, HEAD = 38;
    const top = X.contentTop() - 4, W = Math.round(X.violins.zoomed ? box.width : Math.min(box.width, G.END + 52)), H = Math.round(box.height - top + HEAD);
    const canvas = document.createElement('canvas');
    canvas.width = W * k;
    canvas.height = H * k;
    const ctx = canvas.getContext('2d');
    ctx.scale(k, k);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    const layers = ['v-under', 'v-dots', 'v-over', 'v-heat'].map((id) => $(id));
    const images = await Promise.all(layers.map((el) => (el.tagName.toLowerCase() === 'svg' ? svgImage(el) : null)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEAD, W, H - HEAD);
    ctx.clip();
    X.violins.redrawDots();
    layers.forEach((el, j) => {
      const r = el.getBoundingClientRect();
      ctx.drawImage(images[j] || el, r.left - box.left, r.top - box.top - top + HEAD, r.width, r.height);
    });
    // Factors are HTML controls above the SVG layers. Draw their visible labels into the exported image too.
    for (const pill of $('v-factors').querySelectorAll('[data-pill]')) {
      const r = pill.getBoundingClientRect(), style = getComputedStyle(pill);
      const x = r.left-box.left, y = r.top-box.top-top+HEAD;
      ctx.fillStyle=style.backgroundColor;ctx.strokeStyle=style.borderColor;ctx.lineWidth=1;
      ctx.beginPath();ctx.roundRect(x,y,r.width,r.height,Math.min(r.height/2,8));ctx.fill();ctx.stroke();
      ctx.fillStyle=style.color;ctx.font=style.font || `500 12px ${X.SANS}`;ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(pill.textContent,x+r.width/2,y+r.height/2);
    }
    ctx.restore();
    key(ctx, T, W);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      if (!downloadFile && navigator.clipboard?.write && window.ClipboardItem) try {
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);X.copied($('picture'));return;
      } catch (_) { /* File URLs and browser permissions may prevent clipboard access. */ }
      await save(blob, fileName('png'));
    }
  }
  function svgImage(el) {
    const r = el.getBoundingClientRect(), copy = el.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', String(r.width));
    copy.setAttribute('height', String(r.height));
    // Span paths in its attributes hold control characters, which XML does not allow.
    const text = new XMLSerializer().serializeToString(copy).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('svg')); };
      img.src = url;
    });
  }
  // The title, and each half's groups and each marked group by its mark, as the legend shows them.
  function key(ctx, T, W) {
    const font = (weight, size) => `${weight} ${size}px ${X.SANS}`;
    ctx.fillStyle = T.ink;
    ctx.font = font(600, 14);
    ctx.textBaseline = 'middle';
    ctx.fillText(X.meta.title || X.UNIT, 16, 20);
    let x = 16 + ctx.measureText(X.meta.title || X.UNIT).width + 24;
    ctx.font = font(400, 12.5);
    const item = (draw, text) => {
      if (!text) return;
      draw(x + 5, 20);
      ctx.fillStyle = T.ink;
      ctx.fillText(text, x + 15, 20);
      x += 15 + ctx.measureText(text).width + 18;
    };
    for (const side of ['left', 'right']) {
      item((cx, cy) => { ctx.fillStyle = T[side]; ctx.beginPath(); ctx.arc(cx, cy, 4.5, side === 'left' ? Math.PI / 2 : -Math.PI / 2, side === 'left' ? Math.PI * 1.5 : Math.PI / 2); ctx.fill(); }, X.sideNames(side));
    }
    for (const g of X.unitsInView(true).markers.keys()) {
      item((cx, cy) => { ctx.strokeStyle = T[`m${X.slotOf(g)}`]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, cy - 4.5); ctx.lineTo(cx + 4.5, cy); ctx.lineTo(cx, cy + 4.5); ctx.lineTo(cx - 4.5, cy); ctx.closePath(); ctx.stroke(); }, X.groupName(g));
    }
  }

  async function save(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  X.copied=button=>{if(!button)return;const original=button.innerHTML,title=button.title;button.innerHTML='✓';button.title='Copied';setTimeout(()=>{button.innerHTML=original;button.title=title;},1400);};
  X.download = { init, build, picture, save };
})();
