(function () {
  'use strict';
  const X=window.TX, {$,esc}=X;
  let library=[],active=null,initialized=false,applying=false,dragged=null;
  const key=()=>`violinoscope.layouts.${X.UNIT}`;
  const newId=()=>globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const selected=()=>library.find(d=>d.id===active);
  const current=()=>({unit:X.UNIT,name:selected()?.name || 'Layout',layout:X.layout.state()});
  const store=()=>{try{localStorage.setItem(key(),JSON.stringify({library,active}));}catch(_){X.toast('Browser storage is unavailable; copy a layout to keep it');}};
  function saveCurrent() { const doc=selected();if(doc && !applying){doc.layout=X.layout.state();store();} }
  function close() { $('layout-menu').hidden=true;$('layouts').setAttribute('aria-expanded','false'); }
  const icon=(action,title,path)=>`<button type="button" class="quiet-btn" data-layout-${action} title="${title}" aria-label="${title}"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  function render() {
    if(!X.layout.ready)return;
    const button=$('layouts'),menu=$('layout-menu');button.disabled=false;button.title=selected()?.name || 'Layouts';
    if(menu.hidden)return;
    menu.innerHTML='<div class="layout-head"><b>Layouts</b>'
      +icon('clear','Clear layout','M3 5h10M6 5V3h4v2M5 7v6h6V7')
      +icon('new','Save as a new layout','M8 3v10M3 8h10')
      +icon('import','Paste layout · Shift-click to open a file','M6 3H3v11h10V3h-3M6 2h4v3H6zM8 7v5M6 10l2 2 2-2')
      +icon('export','Copy layout · Shift-click to download a file','M6 6h8v8H6zM10 3V2H2v8h1')
      +icon('close','Close layouts','M4 4l8 8M12 4l-8 8')+'</div>'
      +`<div class="layout-list">${library.map((d,i)=>`<div class="layout-row${d.id===active?' on':''}" data-layout-row="${i}"><span class="layout-grip" draggable="true" data-layout-drag="${i}" title="Drag to reorder · Alt+↑/↓ on the name">⠿</span><button type="button" class="layout-choice" data-layout-load="${i}" title="${esc(d.name)} · double-click or F2 to rename">${esc(d.name)}</button><button type="button" class="quiet-btn" data-layout-delete="${i}" title="Remove ${esc(d.name)}" aria-label="Remove ${esc(d.name)}">×</button></div>`).join('')}</div>`
      +(X.layoutFiles.missing(current()).length?`<p class="layout-note">${X.layoutFiles.missing(current()).length} span names aren’t in this dataset. Their definitions are kept.</p>`:'');
    place();
  }
  function place() {
    const menu=$('layout-menu');if(menu.hidden)return;
    const anchor=$('layouts').getBoundingClientRect();menu.style.position='fixed';menu.style.top=`${anchor.bottom+8}px`;menu.style.left=`${Math.max(12,Math.min(anchor.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))}px`;menu.style.right='auto';menu.style.maxHeight=`${Math.max(60,innerHeight-anchor.bottom-20)}px`;
  }
  function apply(doc) {
    if(doc.unit!==X.UNIT)throw Error(`This layout is for ${doc.unit}; this page contains ${X.UNIT}`);
    saveCurrent();applying=true;
    try {X.layout.load(doc.layout);active=doc.id;doc.layout=X.layout.state();}
    finally {applying=false;}
    store();render();
  }
  function rename(index) {
    const row=$('layout-menu').querySelector(`[data-layout-row="${index}"]`);if(!row)return;
    const doc=library[index],button=row.querySelector('.layout-choice'),input=document.createElement('input');
    input.className='layout-name';input.value=doc.name;input.maxLength=120;input.setAttribute('aria-label','Layout name');button.replaceWith(input);
    let finished=false;
    const finish=cancel=>{if(finished)return;finished=true;if(!cancel && input.value.trim())doc.name=input.value.trim();store();render();};
    input.onkeydown=e=>{if(e.key==='Enter'||e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(e.key==='Escape');}};
    input.onblur=()=>finish(false);input.focus({preventScroll:true});input.scrollIntoView({block:'nearest'});input.select();
  }
  function create() {
    saveCurrent();const doc={...current(),id:newId(),name:'New layout'};library.push(doc);active=doc.id;store();render();rename(library.length-1);
  }
  async function importText(text) {
    if(text.length>5e6)throw Error('Layout file is too large');
    const doc={...X.layoutFiles.decode(text),id:newId()};
    apply(doc);library.push(doc);store();render();X.toast('Layout imported');
  }
  async function importFile(file) {
    if(!file)return;
    try{if(file.size>5e6)throw Error('Layout file is too large');await importText(await file.text());}
    catch(e){X.toast(`Couldn’t import layout: ${e.message}`);}
  }
  async function paste(file) {
    if(file){$('layout-file').click();return;}
    let text;
    try{text=await navigator.clipboard.readText();}
    catch(_){$('layout-file').click();return;}
    try{await importText(text);}catch(e){X.toast(`Couldn’t import layout: ${e.message}`);}
  }
  async function copy(file) {
    const doc=current(),text=X.layoutFiles.stringify(doc);
    if(!file)try{await navigator.clipboard.writeText(text);X.copied($('layout-menu').querySelector('[data-layout-export]'));return;}catch(_){}
    await X.download.save(new Blob([text],{type:'application/json'}),doc.name.replace(/[\\/:*?"<>|]/g,'-')+'.layout.json');
  }
  function reorder(from,to) {
    if(from===to||from<0||to<0||to>=library.length)return;
    library.splice(to,0,library.splice(from,1)[0]);store();render();
  }
  function init() {
    window.addEventListener('resize',place);
    $('layouts').onclick=()=>{const open=$('layout-menu').hidden;$('layout-menu').hidden=!open;$('layouts').setAttribute('aria-expanded',String(open));render();};
    const menu=$('layout-menu');
    menu.onclick=e=>{
      const el=e.target.closest('button');if(!el)return;
      if(el.hasAttribute('data-layout-close'))close();
      if(el.hasAttribute('data-layout-new'))create();
      if(el.hasAttribute('data-layout-clear'))X.layout.fresh();
      if(el.hasAttribute('data-layout-load'))try{apply(library[Number(el.dataset.layoutLoad)]);}catch(err){X.toast(err.message);}
      if(el.hasAttribute('data-layout-import'))paste(e.shiftKey);
      if(el.hasAttribute('data-layout-export'))copy(e.shiftKey);
      if(el.hasAttribute('data-layout-delete')){
        const index=Number(el.dataset.layoutDelete),removed=library.splice(index,1)[0];
        if(removed?.id===active)active=null;store();render();
      }
    };
    menu.ondblclick=e=>{const el=e.target.closest('[data-layout-load]');if(el)rename(Number(el.dataset.layoutLoad));};
    menu.onkeydown=e=>{
      const el=e.target.closest('[data-layout-load]');
      if(el && e.key==='F2'){e.preventDefault();rename(Number(el.dataset.layoutLoad));}
      if(el && e.altKey && ['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const from=Number(el.dataset.layoutLoad),to=from+(e.key==='ArrowUp'?-1:1);reorder(from,to);menu.querySelector(`[data-layout-load="${to}"]`)?.focus();}
      if(e.key==='Escape'){close();$('layouts').focus();e.stopPropagation();}
    };
    menu.ondragstart=e=>{const el=e.target.closest('[data-layout-drag]');if(!el)return;dragged=Number(el.dataset.layoutDrag);e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','layout');};
    menu.ondragover=e=>{if(dragged!==null)e.preventDefault();};
    menu.ondrop=e=>{if(dragged===null)return;e.preventDefault();e.stopPropagation();const row=e.target.closest('[data-layout-row]');if(row)reorder(dragged,Number(row.dataset.layoutRow));dragged=null;};
    menu.ondragend=()=>{dragged=null;};
    $('layout-file').onchange=e=>{importFile(e.target.files[0]);e.target.value='';};
    document.addEventListener('pointerdown',e=>{if(!e.target.closest('#layout-menu,#layouts'))close();});
    document.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files'))e.preventDefault();});
    document.addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();importFile(e.dataTransfer.files[0]);}});
    const ready=()=>{
      if(!X.layout.ready)return;
      if(!initialized){
        initialized=true;
        try{const saved=JSON.parse(localStorage.getItem(key())||'{}');library=(saved.library||[]).map(d=>({...X.layoutFiles.decode(d),id:d.id||newId()}));active=library.find(d=>d.id===saved.active||d.name===saved.active)?.id||null;}catch(_){library=[];}
        const saved=window.EXPLORER_LAYOUT;
        if(saved?.layout)try{const doc={...X.layoutFiles.decode({...saved,name:saved.name||'Default'}),id:newId()};if(!library.length){library.push(doc);active=doc.id;}}catch(e){X.toast(`Couldn’t read saved layout: ${e.message}`);}
        if(!library.length){const doc={...current(),name:'Default',id:newId()};library.push(doc);active=doc.id;}
      }
      saveCurrent();render();
    };
    X.on('layout',ready);ready();
  }
  X.layouts={init,current,importFile,importText};
})();
