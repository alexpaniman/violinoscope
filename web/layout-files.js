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
    return {unit:doc.unit, name:typeof doc.name==='string' ? doc.name : 'Imported layout', layout:D.validate(doc.unit,doc.layout)};
  }
  function decode(input) {
    const doc = typeof input==='string' ? JSON.parse(input) : clone(input);
    if (doc.format!=='violinoscope-layout') return validate(doc);
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
  function encode(input) {
    const doc=validate(input),s=doc.layout,paths=[],ids=new Map();
    const ref=r=>{
      const rest=D.restParts(r);if(rest)return D.rest(...rest.map(ref));
      const copy=r.startsWith(COPY),key=D.source(r),scope=D.scope(r);
      if (key!==doc.unit && !key.startsWith(doc.unit+SEP)) return r;
      if (!ids.has(key)) { ids.set(key,paths.length); paths.push(key.split(SEP)); }
      return `${copy ? 'p'+(scope ? scope+':' : '') : 's'}${ids.get(key)}`;
    };
    const out={format:'violinoscope-layout',version:3,name:doc.name,unit:doc.unit,paths};
    for (const k of lists) if(s[k]?.length) out[k]=s[k].map(ref);
    for (const k of pairs) if(s[k]?.length) out[k]=Object.fromEntries(s[k].map(([a,b])=>[ref(a),k==='names' ? b : ref(b)]));
    for (const k of many) if(s[k]?.length) out[k]=Object.fromEntries(s[k].map(([a,b])=>[ref(a),b.map(ref)]));
    if(s.retained?.length) out.retained=Object.fromEntries(s.retained.map(([id,cuts])=>[ref(id),cuts.map(cut=>D.mapExpression(cut,ref))]));
    if(s.definitions?.length) out.definitions=Object.fromEntries(s.definitions.map(([id,inputs])=>[ref(id),inputs.map(input=>mapInput(input,ref))]));
    if(s.groups?.length) out.groups=s.groups.map(([id,name,inputs,more={}])=>({id,name,inputs:inputs.map(input=>mapInput(input,ref)),
      ...(more.tree===2 ? {tree:'projections',...(more.scope ? {scope:more.scope} : {})} : {}),...(more.match ? {match:{...more.match,under:ref(more.match.under)}} : {})}));
    return out;
  }
  const missing=doc=>encode(doc).paths.map(p=>p.join(SEP)).filter(p=>!X.layout.hasPath(p));
  function preserveMissing(source,current) {
    if(!source || current.v>=5) return current;
    const absent=new Set(missing(source)),out=clone(current),old=source.layout;
    const lost=id=>absent.has(D.source(id));
    for(let changed=true;changed;){changed=false;for(const [id,,members] of old.groups || []) if(!absent.has(id) && members.length && members.every(lost)){absent.add(id);changed=true;}}
    for(const k of lists) out[k]=[...new Set([...(out[k] || []),...(old[k] || []).filter(lost)])];
    const groups=new Map((out.groups || []).map(g=>[g[0],g]));
    for(const g of old.groups || []) {
      if(groups.has(g[0])) groups.get(g[0])[2]=[...new Set([...groups.get(g[0])[2],...g[2].filter(lost)])];
      else if(lost(g[0])) { groups.set(g[0],clone(g)); if(old.shown?.includes(g[0])) out.shown.push(g[0]); }
    }
    out.groups=[...groups.values()];
    for(const k of [...pairs,...many]) {
      const entries=new Map(out[k] || []);
      for(const [a,b] of old[k] || []) {
        if(lost(a)) entries.set(a,clone(b));
        else if(many.includes(k)) { const keep=b.filter(lost); if(keep.length) entries.set(a,[...new Set([...(entries.get(a)||[]),...keep])]); }
      }
      out[k]=[...entries];
    }
    return out;
  }
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
