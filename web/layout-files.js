// Portable named layouts. Paths occur once; sN is a span and pN its projection.
(function () {
  'use strict';
  const X = window.TX, SEP = '\u0001', COPY = '\u0002';
  const lists = ['shown','open','skip','top2'], pairs = ['parents','names'], many = ['order','except'];
  const clone = x => JSON.parse(JSON.stringify(x));
  function validate(doc) {
    if (!doc || typeof doc.unit !== 'string' || !doc.unit || !doc.layout || ![1,2,3,4].includes(doc.layout.v || 1)) throw Error('Unsupported layout file');
    const s = doc.layout, groups = new Map();
    for (const g of s.groups || []) {
      if (!Array.isArray(g) || !/^g\d+$/.test(g[0]) || typeof g[1] !== 'string' || !Array.isArray(g[2]) || groups.has(g[0])) throw Error('Invalid merged violin');
      groups.set(g[0],g[2]);
    }
    const valid = id => typeof id === 'string' && (groups.has(id) || ['~root','~two','~rest','_all'].includes(id) ||
      [id,id.startsWith(COPY) ? id.slice(1) : id].some(v=>v===doc.unit || v.startsWith(doc.unit+SEP)));
    const refs = a => { if (!Array.isArray(a) || a.some(v=>!valid(v))) throw Error('Invalid span reference'); };
    for (const k of lists) refs(s[k] || []);
    for (const k of [...pairs,...many]) {
      if (s[k] && !Array.isArray(s[k])) throw Error('Invalid layout entries');
      for (const entry of s[k] || []) {
        if (!Array.isArray(entry) || entry.length!==2 || !valid(entry[0])) throw Error('Invalid layout entry');
        if (k==='names') { if (typeof entry[1]!=='string') throw Error('Invalid violin name'); }
        else refs(many.includes(k) ? entry[1] : [entry[1]]);
      }
    }
    const parents = new Map(s.parents || []);
    for (const [g,members] of groups) { refs(members); for (const m of members) parents.set(m,g); }
    for(const [id,,,more={}] of s.groups || []) {
      if(more.parent) {refs([more.parent]);parents.set(id,more.parent);}
      if(more.match) {refs([more.match.under]);if(typeof more.match.text!=='string')throw Error('Invalid span filter');}
    }
    for (const id of parents.keys()) {
      const seen = new Set();
      for (let p=id; p; p=parents.has(p) ? parents.get(p) : p.includes(SEP) ? p.slice(0,p.lastIndexOf(SEP)) : null) { if (seen.has(p)) throw Error('Layout contains a cycle'); seen.add(p); }
    }
    return {unit:doc.unit,name:typeof doc.name==='string' ? doc.name : 'Imported layout',layout:clone(s)};
  }
  function decode(input) {
    const doc = typeof input==='string' ? JSON.parse(input) : clone(input);
    if (doc.format!=='violinoscope-layout') return validate(doc);
    if (doc.version!==1 || !Array.isArray(doc.paths)) throw Error('Unsupported layout format');
    const paths = doc.paths.map(p=>{
      if (!Array.isArray(p) || !p.length || p[0]!==doc.unit || p.some(n=>typeof n!=='string' || /[\u0001\u0002]/.test(n))) throw Error('Invalid span path');
      return p.join(SEP);
    });
    const ref = r => {
      const m = typeof r==='string' && /^([sp])(\d+)$/.exec(r);
      if (!m) return r;
      if (!paths[Number(m[2])]) throw Error('Unknown span path');
      return (m[1]==='p' ? COPY : '')+paths[Number(m[2])];
    };
    const s = {v:4};
    for (const k of lists) s[k]=(doc[k] || []).map(ref);
    for (const k of pairs) s[k]=Object.entries(doc[k] || {}).map(([a,b])=>[ref(a),k==='names' ? b : ref(b)]);
    for (const k of many) s[k]=Object.entries(doc[k] || {}).map(([a,b])=>[ref(a),b.map(ref)]);
    s.groups=(doc.groups || []).map(g=>[g.id,g.name,g.parts.map(ref),{...(g.tree==='projections' ? {tree:2} : {}),...(g.match ? {match:{...g.match,under:ref(g.match.under)}} : {})}]);
    s.next=1+Math.max(0,...s.groups.map(g=>Number(g[0].slice(1))));
    return validate({unit:doc.unit,name:doc.name,layout:s});
  }
  function encode(input) {
    const doc=validate(input),s=doc.layout,paths=[],ids=new Map();
    const ref=r=>{
      const copy=r.startsWith(COPY),key=copy ? r.slice(1) : r;
      if (key!==doc.unit && !key.startsWith(doc.unit+SEP)) return r;
      if (!ids.has(key)) { ids.set(key,paths.length); paths.push(key.split(SEP)); }
      return `${copy ? 'p' : 's'}${ids.get(key)}`;
    };
    const out={format:'violinoscope-layout',version:1,name:doc.name,unit:doc.unit,paths};
    for (const k of lists) if(s[k]?.length) out[k]=s[k].map(ref);
    for (const k of pairs) if(s[k]?.length) out[k]=Object.fromEntries(s[k].map(([a,b])=>[ref(a),k==='names' ? b : ref(b)]));
    for (const k of many) if(s[k]?.length) out[k]=Object.fromEntries(s[k].map(([a,b])=>[ref(a),b.map(ref)]));
    if(s.groups?.length) out.groups=s.groups.map(([id,name,parts,more={}])=>({id,name,parts:parts.map(ref),
      ...(more.tree===2 ? {tree:'projections'} : {}),...(more.match ? {match:{...more.match,under:ref(more.match.under)}} : {})}));
    return out;
  }
  const missing=doc=>encode(doc).paths.map(p=>p.join(SEP)).filter(p=>!X.layout.hasPath(p));
  function preserveMissing(source,current) {
    if(!source) return current;
    const absent=new Set(missing(source)),out=clone(current),old=source.layout;
    const lost=id=>absent.has(id.startsWith(COPY) ? id.slice(1) : id);
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
  X.layoutFiles={encode,decode,missing,preserveMissing};
})();
