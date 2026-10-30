// Portable named layouts. Paths occur once; sN is a span and pN its projection.
(function () {
  'use strict';
  const X = window.TX, SEP = '\u0001', COPY = '\u0002';
  const lists = ['shown','open','skip','top2'], pairs = ['parents','names'], many = ['order','except','bounds'];
  const clone = x => JSON.parse(JSON.stringify(x));
  const D = window.ViolinDefinitions;
  const mapInput=(input,ref)=>({...input,...(input.span ? {span:ref(input.span)} : {violin:ref(input.violin)}),...(input.cuts ? {cuts:input.cuts.map(cut=>D.mapExpression(cut,ref))} : {})});
  function validate(doc) {
    if (!doc || typeof doc.unit !== 'string' || !doc.unit || !doc.layout) throw Error('Unsupported layout file');
    const old=doc.layout.v===7?doc.layout:D.validate(doc.unit,doc.layout);
    return {unit:doc.unit,name:typeof doc.name==='string'?doc.name:'Imported layout',layout:window.ViolinTree.migrate(doc.unit,old)};
  }
  function decode(input) {
    const doc = typeof input==='string' ? JSON.parse(input) : clone(input);
    if (doc.format!=='violinoscope-layout') return validate(doc);
    if(doc.version===4){
      let next=1;
      const node=(n,root=false)=>{if(!n||typeof n!=='object'||Array.isArray(n)||Object.keys(n).some(k=>!['span','group','name','children','hidden','open','rest'].includes(k)))throw Error('Invalid tree node');return {...n,id:root?doc.unit:'n'+next++,children:(n.children||[]).map(c=>node(c))};};
      return validate({unit:doc.unit,name:doc.name,layout:{v:7,unit:doc.unit,main:node(doc.tree,true),projections:(doc.projections||[]).map(n=>node(n))}});
    }
    if (![1,2,3].includes(doc.version) || !Array.isArray(doc.paths)) throw Error('Unsupported layout format');
    const paths = doc.paths.map(p=>{
      if (!Array.isArray(p) || !p.length || p[0]!==doc.unit || p.some(n=>typeof n!=='string' || /[\u0001-\u0003]/.test(n))) throw Error('Invalid span path');
      return p.join(SEP);
    });
    const ref = r => {
      const rest=D.restParts(r);if(rest)return D.rest(...rest.map(ref));
      const m = typeof r==='string' && /^([sp])(?:([a-z0-9]+):)?(\d+)$/i.exec(r);
      if (!m) return r;
      if (!paths[Number(m[3])]) throw Error('Unknown span path');
      return m[1]==='p' ? D.copy(paths[Number(m[3])],m[2] || '') : paths[Number(m[3])];
    };
    const s = {v:doc.version===3 ? 6 : doc.version===2 ? 5 : 4};
    for (const k of lists) s[k]=(doc[k] || []).map(ref);
    for (const k of pairs) s[k]=Object.entries(doc[k] || {}).map(([a,b])=>[ref(a),k==='names' ? b : ref(b)]);
    for (const k of many) s[k]=Object.entries(doc[k] || {}).map(([a,b])=>[ref(a),b.map(ref)]);
    s.retained=Object.entries(doc.retained || {}).map(([id,cuts])=>[ref(id),cuts.map(cut=>D.mapExpression(cut,ref))]);
    s.definitions=Object.entries(doc.definitions || {}).map(([id,inputs])=>[ref(id),inputs.map(input=>mapInput(input,ref))]);
    s.groups=(doc.groups || []).map(g=>[g.id,g.name,g.inputs ? g.inputs.map(input=>mapInput(input,ref)) : g.parts.map(ref),{...(g.tree==='projections' ? {tree:2,scope:g.scope || ''} : {}),...(g.match ? {match:{...g.match,under:ref(g.match.under)}} : {})}]);
    s.next=1+Math.max(0,...s.groups.map(g=>Number(g[0].slice(1))));
    return validate({unit:doc.unit,name:doc.name,layout:s});
  }
  function encode(input){
    const doc=validate(input),node=n=>{const out=n.span?{span:n.span}:{group:n.group};if(n.name)out.name=n.name;for(const flag of ['open','hidden','rest'])if(n[flag])out[flag]=true;if(n.children.length)out.children=n.children.map(node);return out;};
    return {format:'violinoscope-layout',version:4,name:doc.name,unit:doc.unit,tree:node(doc.layout.main),...(doc.layout.projections.length?{projections:doc.layout.projections.map(node)}:{})};
  }
  const missing=doc=>{const names=new Set(),visit=n=>{if(n.span&&n.span!==window.ViolinTree.GAP&&!X.layout.hasName(n.span))names.add(n.span);n.children.forEach(visit);};const s=validate(doc).layout;visit(s.main);s.projections.forEach(visit);return [...names];};
  const preserveMissing=(_,current)=>clone(current);
  function stringify(doc) {
    const pretty=(value,depth=0)=>{
      if(!value || typeof value!=='object')return JSON.stringify(value);
      const indent='  '.repeat(depth),child=indent+'  ';
      if(Array.isArray(value)) {
        if(value.every(v=>!v || typeof v!=='object'))return '['+value.map(v=>JSON.stringify(v)).join(', ')+']';
        return '[\n'+value.map(v=>child+pretty(v,depth+1)).join(',\n')+'\n'+indent+']';
      }
      const entries=Object.entries(value);
      return entries.length ? '{\n'+entries.map(([k,v])=>child+JSON.stringify(k)+': '+pretty(v,depth+1)).join(',\n')+'\n'+indent+'}' : '{}';
    };
    return pretty(encode(doc))+'\n';
  }
  X.layoutFiles={encode,decode,stringify,missing,preserveMissing};
})();
