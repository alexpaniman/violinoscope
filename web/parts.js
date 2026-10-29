// Coarsen a partition without duplicating or losing any of its buckets.
(function () {
  'use strict';
  const X = window.TX;
  X.coarsenParts = (mean, children, tops, none, wide = 0.1, broad = 0.05) => {
    const under = (k) => [k, ...(children[k] || []).flatMap(under)];
    const values = (ks) => mean.map((row) => ks.reduce((a, k) => a + row[k], 0));
    const mass = (ks) => values(ks).reduce((a, v) => a + v, 0);
    const matters = (ks) => { const v = values(ks); return v.some((s) => s >= wide) || mass(ks) / Math.max(1, mean.length) >= broad; };
    function split(k, force = false) {
      const kids = children[k] || [], whole = under(k);
      const selected = new Set(kids.filter((c) => matters(under(c)))), promoted = new Set();
      // A meaningful child gets a name even if it matters only at one end of the duration axis.
      // Dominance is only a way to explain a meaningful leftover with a smaller named child.
      let remaining = kids.filter((c) => !selected.has(c));
      while (remaining.length) {
        const rest = [k, ...remaining.flatMap(under)];
        if (!matters(rest) && !(force && !selected.size)) break;
        const dominant = remaining.find((c) => mass(under(c)) > 0 && mass(under(c)) >= mass(rest) * 2 / 3);
        if (dominant === undefined) break;
        selected.add(dominant); promoted.add(dominant);
        remaining = remaining.filter((c) => c !== dominant);
      }
      if (!selected.size) return [{ks: whole, node: k, kind: 'whole', keep: force}];
      const parts = [{ks: [k], node: k, kind: 'own'}, ...kids.filter((c) => selected.has(c)).flatMap((c) => split(c, promoted.has(c)))];
      if (remaining.length) parts.push({ks: remaining.flatMap(under), node: k, kind: 'steps', roots: remaining});
      return parts;
    }
    const all = [...tops.flatMap((k) => split(k)), {ks:[none], node:none, kind:'whole'}], kept = [], other = [], components = [];
    for (const part of all) if (part.keep || matters(part.ks)) kept.push(part); else other.push(...part.ks);
    for (const part of all) if (!part.keep && !matters(part.ks)) components.push(part);
    if (other.length) {
      // After selecting meaningful work, spend a little of a large Other band's label space on smaller steps.
      // The combined area must fit the remaining Other label plus each extra label; promote at most two.
      const height = Math.max(210,(kept.length+1)*14), shares = values(other);
      let slots = Math.min(2,Math.max(0,Math.floor(Math.max(...shares)*height/14)-1));
      const candidates = components.flatMap(p => p.kind==='steps'
        ? p.roots.map(k=>({ks:under(k),node:k,kind:'whole'})) : [p]);
      const eligible = candidates.filter(p=>p.node!==none && p.kind!=='own' && mass(p.ks)/Math.max(1,mean.length)>=.015)
        .sort((a,b)=>mass(b.ks)-mass(a.ks));
      const promoted = new Set();
      if (mass(other)/Math.max(1,mean.length)>=.15) for (const p of eligible) {
        if (!slots--) break;
        kept.push({...p,extra:true});for(const k of p.ks)promoted.add(k);
      }
      const rest=other.filter(k=>!promoted.has(k));
      if(rest.length) kept.push({ks:rest,other:true,components:candidates.map(p=>({...p,ks:p.ks.filter(k=>!promoted.has(k))})).filter(p=>p.ks.length)});
    }
    return kept;
  };
})();
