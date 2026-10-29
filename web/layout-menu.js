(function () {
  'use strict';
  const X=window.TX, {$,esc}=X;
  let library=[],active=null,base=null,initialized=false,baseline='';
  const key=()=>`violinoscope.layouts.${X.UNIT}`;
  const store=()=>{try{localStorage.setItem(key(),JSON.stringify({library,active}));}catch(_){X.toast('Browser storage is unavailable; export a layout to keep it');}};
  const current=()=>({unit:X.UNIT,name:active || 'Layout',layout:X.layoutFiles.preserveMissing(base,X.layout.state())});
  const changed=()=>!base || JSON.stringify(X.layout.state())!==baseline;
  function close() { $('layout-menu').hidden=true; $('layouts').setAttribute('aria-expanded','false'); }
  function render() {
    if(!X.layout.ready) return;
    const button=$('layouts');button.disabled=false;
    button.title=`${active || 'Layouts'}${changed() ? ' · Modified' : ''}`;
    button.classList.toggle('modified',!!base && changed());
    if($('layout-menu').hidden) return;
    const anchor=button.getBoundingClientRect(), menu=$('layout-menu');
    menu.style.position='fixed';menu.style.top=`${anchor.bottom+8}px`;menu.style.left=`${Math.max(12,Math.min(anchor.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))}px`;menu.style.right='auto';
    $('layout-menu').innerHTML='<div class="layout-head"><b>Layouts</b><button type="button" class="quiet-btn" data-layout-close aria-label="Close layouts">×</button></div>'
      +`<div class="layout-list">${library.map((d,i)=>`<button type="button" data-layout-load="${i}" class="layout-choice${d.name===active ? ' on' : ''}">${esc(d.name)}${d.name===active && changed() ? '<span>Modified</span>' : ''}</button>`).join('')}</div>`
      +`<form id="layout-save-form"><input id="layout-name" aria-label="Layout name" placeholder="Name a layout" value="${esc(active || '')}" maxlength="120"><button type="submit" class="text-btn small">Save</button></form>`
      +`<div class="layout-actions"><button type="button" class="text-btn small" data-layout-import>Import…</button><button type="button" class="text-btn small" data-layout-export>Export…</button>${active ? '<button type="button" class="text-btn small" data-layout-delete>Delete</button>' : ''}</div>`
      +(base && X.layoutFiles.missing(base).length ? `<p class="layout-note">${X.layoutFiles.missing(base).length} referenced paths aren’t in this dataset. They are kept in the saved layout.</p>` : '');
  }
  function apply(doc) {
    if(doc.unit!==X.UNIT) throw Error(`This layout is for ${doc.unit}; this page contains ${X.UNIT}`);
    X.layout.load(doc.layout);active=doc.name;base=doc;baseline=JSON.stringify(X.layout.state());store();render();
    const absent=X.layoutFiles.missing(doc).length;
    X.toast(absent ? `Layout loaded · ${absent} paths absent from this dataset` : 'Layout loaded');
  }
  async function importFile(file) {
    if(!file) return;
    try {
      if(file.size>5e6) throw Error('Layout file is too large');
      const doc=X.layoutFiles.decode(await file.text());
      if(doc.unit!==X.UNIT) throw Error(`This layout is for ${doc.unit}; this page contains ${X.UNIT}`);
      let name=doc.name,n=2;while(library.some(d=>d.name===name))name=`${doc.name} ${n++}`;
      doc.name=name;apply(doc);library.push(doc);store();render();
    }catch(e){X.toast(`Couldn’t import layout: ${e.message}`);}
  }
  function init() {
    $('layouts').onclick=()=>{const open=$('layout-menu').hidden;$('layout-menu').hidden=!open;$('layouts').setAttribute('aria-expanded',String(open));render();};
    $('layout-menu').onclick=e=>{
      const el=e.target.closest('button');if(!el)return;
      if(el.hasAttribute('data-layout-close'))close();
      if(el.hasAttribute('data-layout-load')){try{apply(library[Number(el.dataset.layoutLoad)]);}catch(err){X.toast(err.message);}}
      if(el.hasAttribute('data-layout-import'))$('layout-file').click();
      if(el.hasAttribute('data-layout-export')){
        const doc=current(),file=`${doc.name.replace(/[\\/:*?"<>|]/g,'-')}.layout.json`;
        X.download.save(new Blob([X.layoutFiles.stringify(doc)],{type:'application/json'}),file);
      }
      if(el.hasAttribute('data-layout-delete')){library=library.filter(d=>d.name!==active);active=null;base=null;store();render();}
    };
    $('layout-menu').onsubmit=e=>{
      e.preventDefault();const name=$('layout-name').value.trim();if(!name)return;
      const doc={...current(),name},at=library.findIndex(d=>d.name===name);
      if(at<0)library.push(doc);else library[at]=doc;
      active=name;base=doc;baseline=JSON.stringify(X.layout.state());store();render();X.toast('Layout saved');
    };
    $('layout-file').onchange=e=>{importFile(e.target.files[0]);e.target.value='';};
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('#layout-menu,#layouts'))close();});
    $('layout-menu').onkeydown=e=>{if(e.key==='Escape'){close();$('layouts').focus();e.stopPropagation();}};
    document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
    document.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();importFile(e.dataTransfer.files[0]);}});
    const ready=()=>{
      if(!X.layout.ready)return;
      if(!initialized){
        initialized=true;
        try{const saved=JSON.parse(localStorage.getItem(key()) || '{}');library=(saved.library || []).map(X.layoutFiles.decode);active=saved.active;}catch(_){library=[];}
        const saved=window.EXPLORER_LAYOUT;
        if(saved?.layout){try{const doc=X.layoutFiles.decode({...saved,name:saved.name || 'Default'});if(!library.some(d=>d.name===doc.name))library.unshift(doc);if(!active)active=doc.name;}catch(e){X.toast(`Couldn’t read saved layout: ${e.message}`);}}
        base=library.find(d=>d.name===active)||null;baseline=base ? JSON.stringify(X.layout.normalize(base.layout)) : '';store();
      }
      render();
    };
    X.on('layout',ready);ready();
  }
  X.layouts={init,current,importFile};
})();
