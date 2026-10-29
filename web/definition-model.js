// Pure definition operations. Source paths identify recordings; scoped references identify copies in an analysis.
// No DOM, unit timings, visibility heuristics or browser storage belong here.
(function () {
  'use strict';
  const SEP = '\u0001', COPY = '\u0002', SCOPE = '\u0003';
  const clone = value => JSON.parse(JSON.stringify(value));
  const source = id => {
    if (typeof id !== 'string' || !id.startsWith(COPY)) return id;
    const at = id.indexOf(SCOPE);
    return at < 0 ? id.slice(1) : id.slice(at + 1);
  };
  const scope = id => {
    if (typeof id !== 'string' || !id.startsWith(COPY)) return null;
    const at = id.indexOf(SCOPE);
    return at < 0 ? '' : id.slice(1, at);
  };
  const copy = (path, context = '') => COPY + (context ? context + SCOPE : '') + source(path);
  const inputKey = input => typeof input === 'string' ? input : input?.span ?? input?.violin;
  const typedInput = input => typeof input === 'string' ? {violin:input} : clone(input);
  function checkInput(input) {
    if(!input || typeof input!=='object' || Object.keys(input).some(k=>!['span','violin','cuts'].includes(k)) ||
      Number('span' in input)+Number('violin' in input)!==1 || typeof inputKey(input)!=='string' || (input.cuts!==undefined && (!Array.isArray(input.cuts)||!input.span)))throw Error('Invalid definition input');
  }
  const rest = (owner,span) => '~rest:'+encodeURIComponent(JSON.stringify([owner,span]));
  function restParts(id) {
    if(typeof id!=='string'||!id.startsWith('~rest:'))return null;
    try{const p=JSON.parse(decodeURIComponent(id.slice(6)));return Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='string'&&!v.startsWith('~rest:'))?p:null;}catch(_){return null;}
  }
  function mapExpression(expression, ref, depth = 0) {
    if (!Array.isArray(expression) || depth > 100) throw Error('Invalid retained coverage');
    const [op, ...args] = expression;
    if (op === 'span' && args.length === 1 && typeof args[0] === 'string') return [op,ref(args[0])];
    if ((op === 'union') || (['subtract','intersect'].includes(op) && args.length === 2))
      return [op,...args.map(e=>mapExpression(e,ref,depth+1))];
    throw Error('Invalid retained coverage');
  }
  function normalize(state) {
    const out = clone(state), groups = new Map((out.groups || []).map(g => [g[0], g]));
    for (const g of groups.values()) {
      const parent = g[3]?.parent;
      if (!parent) continue;
      if (groups.has(parent)) {
        const into = groups.get(parent);
        into[2] = into[2].filter(id => !g[2].includes(id));
        if (!into[2].includes(g[0])) into[2].push(g[0]);
      } else {
        out.parents = (out.parents || []).filter(([id]) => id !== g[0]);
        out.parents.push([g[0], parent]);
      }
      delete g[3].parent;
    }
    for (const g of groups.values()) g[2] = g[2].map(typedInput);
    out.definitions=(out.definitions || []).map(([id,inputs])=>[id,inputs.map(typedInput)]);
    return out;
  }
  function validate(unit, input) {
    const s = normalize(input), groups = new Map(), owners = new Map();
    if (!unit || !s || ![1,2,3,4,5,6].includes(s.v || 1)) throw Error('Unsupported layout file');
    for (const g of s.groups || []) {
      if (!Array.isArray(g) || !/^g\d+$/.test(g[0]) || g[0]===unit || typeof g[1] !== 'string' || !Array.isArray(g[2]) || groups.has(g[0])) throw Error('Invalid violin definition');
      for (const input of g[2]) checkInput(input);
      groups.set(g[0], g[2].map(inputKey));
    }
    const valid = id => {
      if (typeof id !== 'string') return false;
      const remainder=restParts(id);if(remainder)return remainder.every(valid);
      const p = source(id), c = scope(id);
      return groups.has(id) || ['~root','~two','~rest','_all'].includes(id) ||
        ((c === null || /^[a-z0-9]*$/i.test(c)) && (p === unit || p.startsWith(unit + SEP)));
    };
    const refs = list => {
      if (!Array.isArray(list)) throw Error('Invalid definition references');
      const invalid = list.filter(id => !valid(id));
      if (invalid.length) throw Error(`Invalid definition reference: ${invalid[0]}`);
    };
    const recipes = new Map((s.groups || []).map(g=>[g[0],g[2]]));
    for (const [id,inputs] of s.definitions || []) {
      refs([id]);if(!source(id).startsWith(unit+SEP)||recipes.has(id))throw Error('Invalid source definition');
      for(const input of inputs)checkInput(input);
      refs(inputs.map(inputKey));recipes.set(id,inputs);groups.set(id,inputs.map(inputKey));
    }
    for (const key of ['shown','open','skip','top2']) refs(s[key] || []);
    for (const [id,cuts] of s.retained || []) {
      refs([id]); if (!Array.isArray(cuts)) throw Error('Invalid retained coverage');
      for (const cut of cuts) mapExpression(cut,r=>{refs([r]);if(!(source(r)===unit||source(r).startsWith(unit+SEP)))throw Error('Retained coverage requires a recorded span');return r;});
    }
    for (const key of ['parents','names','order','except','bounds']) for (const entry of s[key] || []) {
      if (!Array.isArray(entry) || entry.length !== 2 || !valid(entry[0])) throw Error('Invalid layout entry');
      if (key === 'names') { if (typeof entry[1] !== 'string') throw Error('Invalid violin name'); }
      else refs(['order','except','bounds'].includes(key) ? entry[1] : [entry[1]]);
    }
    for (const [id, members] of groups) {
      refs(members);
      for (const member of members) {
        if(member===id && recipes.get(id)?.some(input=>input.span===id))continue;
        if (member === '~rest' || restParts(member) || member === '~root' || member === '~two' || source(member) === unit) throw Error('A root or remainder cannot be a merge input');
        if (owners.has(member)) throw Error('A violin has more than one owner');
        owners.set(member, id);
      }
    }
    const sourceRef = id => typeof id==='string' && (source(id)===unit || source(id).startsWith(unit+SEP));
    for(const inputs of recipes.values()) for(const input of inputs)if(input.span && !sourceRef(input.span))throw Error('A source input requires a recorded span');
    for(const inputs of recipes.values())for(const input of inputs)for(const cut of input.cuts || [])mapExpression(cut,r=>{refs([r]);if(!sourceRef(r))throw Error('A captured cut requires recorded spans');return r;});
    const tree = id => restParts(id) ? tree(restParts(id)[0]) : scope(id)!==null || id==='~two' || (s.groups || []).some(g=>g[0]===id && g[3]?.tree===2) ? 2 : 1;
    for(const [id,inputs] of recipes)for(const input of inputs)if(tree(id)!==tree(inputKey(input)))throw Error('An input belongs to another analysis');
    for(const key of ['parents','names','order','except','bounds','retained','definitions']) {
      const keys=(s[key] || []).map(entry=>entry[0]);if(new Set(keys).size!==keys.length)throw Error('Duplicate layout entry');
    }
    for(const [id,values] of s.retained || [])if(id===unit && values.length)throw Error('The unit source is fixed');
    for(const key of ['except','bounds'])for(const [id,values] of s[key] || []) {
      if(source(id)===unit && scope(id)===null)throw Error('The unit source is fixed');
      if(values.some(value=>!sourceRef(value)))throw Error('Exclusions and bounds require recorded spans');
    }
    if((s.skip || []).includes(unit))throw Error('The unit source is fixed');
    for(const [id,parent] of s.parents || []) {
      if(id===unit || tree(id)!==tree(parent))throw Error('Invalid analysis placement');
    }
    // Check expression edges separately from placement. A second owner must never mask a cycle.
    const visiting = new Set(), done = new Set();
    const visit = id => {
      if (visiting.has(id)) throw Error('Layout contains a definition cycle');
      if (done.has(id)) return;
      visiting.add(id);
      for (const input of recipes.get(id) || []) if (input.violin && groups.has(input.violin)) visit(input.violin);
      visiting.delete(id); done.add(id);
    };
    for (const id of groups.keys()) visit(id);
    const parents = new Map(s.parents || []);
    for (const [id, parent] of owners) {
      if (parents.has(id) && parents.get(id) !== parent) throw Error('A violin has conflicting placement and membership');
      parents.set(id, parent);
    }
    for (const [id,,,more = {}] of s.groups || []) {
      if (more.scope !== undefined && !/^[a-z0-9]*$/i.test(more.scope)) throw Error('Invalid analysis identity');
      if (more.match) { refs([more.match.under]); if (typeof more.match.text !== 'string') throw Error('Invalid span selector'); }
    }
    const naturalParent = id => {
      const p = source(id), at = p.lastIndexOf(SEP);
      if (at < 0) return null;
      return scope(id) === null ? p.slice(0, at) : copy(p.slice(0, at), scope(id));
    };
    for (const id of parents.keys()) {
      const seen = new Set();
      for (let p = id; p; p = parents.has(p) ? parents.get(p) : naturalParent(p)) {
        if (seen.has(p)) throw Error('Layout contains a placement cycle');
        seen.add(p);
      }
    }
    const basis = id => recipes.has(id) ? recipes.get(id).flatMap(input=>input.span ? [source(input.span)] : basis(input.violin)) : sourceRef(id) ? [source(id)] : [];
    for(const [owner,inputs] of recipes)for(const input of inputs)if(input.span && input.span!==owner && recipes.has(input.span)) {
      const containers=basis(owner);
      if(basis(input.span).some(path=>!containers.some(p=>path===p || path.startsWith(p+SEP))))throw Error('The edited source violin uses spans outside this recipe; restore its source input first');
    }
    for(const [id,parent] of s.parents || []) if(sourceRef(parent) && parent!==unit) {
      const containers=basis(parent);
      if(basis(id).some(path=>!containers.some(p=>path===p || path.startsWith(p+SEP))))throw Error('The containing violin does not cover its child sources');
    }
    return s;
  }
  // Ordered ties are semantic identities, never labels or the order of displayed rows.
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  // One active branch per analysis; independent analyses multiply their factors on intersections.
  // rows are in semantic priority order and already include inherited factors.
  function weightedSegments(total, rows) {
    const events = [], active = new Map(), out = [];
    rows.forEach((row, k) => {
      for (let q = 0; q < row.intervals.length; q += 2) {
        const lo = Math.max(0, row.intervals[q]), hi = Math.min(total, row.intervals[q + 1]);
        if (hi > lo) events.push([lo, k, 1], [hi, k, -1]);
      }
    });
    events.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    let at = 0, factor = 1;
    const append = end => {
      if (end <= at) return;
      if (out.length && out[out.length - 1][2] === factor) out[out.length - 1][1] = end;
      else out.push([at, end, factor]);
      at = end;
    };
    for (let q = 0; q < events.length;) {
      const t = events[q][0]; append(t);
      while (q < events.length && events[q][0] === t) {
        const [, k, delta] = events[q++], context = rows[k].context;
        if (!active.has(context)) active.set(context, new Set());
        if (delta > 0) active.get(context).add(k); else active.get(context).delete(k);
      }
      factor = 1;
      for (const list of active.values()) if (list.size) factor *= rows[Math.min(...list)].factor;
    }
    append(total);
    return out;
  }
  function integrate(intervals, segments, total) {
    let value = 0, j = 0;
    for (let q = 0; q < intervals.length; q += 2) {
      const lo = intervals[q], hi = intervals[q + 1];
      // Independent tails outside the unit are not part of its latency budget.
      value += Math.max(0, Math.min(hi, 0) - lo) + Math.max(0, hi - Math.max(lo, total));
      while (j < segments.length && segments[j][1] <= lo) j++;
      for (let k = j; k < segments.length && segments[k][0] < hi; k++)
        value += Math.max(0, Math.min(hi, segments[k][1]) - Math.max(lo, segments[k][0])) * segments[k][2];
    }
    return value;
  }
  window.ViolinDefinitions = {source, scope, copy, normalize, validate, compare, weightedSegments, integrate, mapExpression, inputKey, typedInput, rest, restParts};
})();
