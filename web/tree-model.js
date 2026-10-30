// The saved model is a tree of name selectors. All scope and ownership information is derived.
(function () {
  'use strict';
  const GAP = '@uncovered',
    ROOT2 = '~two',
    clone = (x) => JSON.parse(JSON.stringify(x));
  const rest = (id) => '~rest:' + id,
    isRest = (id) => typeof id === 'string' && id.startsWith('~rest:');
  const pick = (name) => '~pick:' + encodeURIComponent(name);
  const picked = (id) => (typeof id === 'string' && id.startsWith('~pick:') ? decodeURIComponent(id.slice(6)) : null);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function validate(unit, value) {
    if (!value || value.v !== 7 || value.unit !== unit || !value.main || !Array.isArray(value.projections))
      throw Error('Invalid tree layout');
    if (Object.keys(value).some((k) => !['v', 'unit', 'main', 'projections'].includes(k)))
      throw Error('Unexpected layout state');
    const ids = new Set();
    let count = 0;
    function visit(n, depth) {
      if (++count > 20000 || depth > 150) throw Error('Layout is too large');
      if (
        !n ||
        typeof n.id !== 'string' ||
        !n.id ||
        ids.has(n.id) ||
        n.id === ROOT2 ||
        isRest(n.id) ||
        picked(n.id) !== null
      )
        throw Error('Duplicate or invalid violin identity');
      ids.add(n.id);
      if (
        Number(Object.hasOwn(n, 'span')) + Number(Object.hasOwn(n, 'group')) !== 1 ||
        typeof (n.span ?? n.group) !== 'string' ||
        !(n.span ?? n.group)
      )
        throw Error('A violin needs one span name or a group name');
      if (n.span !== undefined && (!n.span || /[\u0000-\u0003]/.test(n.span))) throw Error('Invalid span name');
      if (n.name !== undefined && typeof n.name !== 'string') throw Error('Invalid violin label');
      if (!Array.isArray(n.children)) throw Error('A violin needs a child list');
      for (const key of ['hidden', 'open', 'rest'])
        if (n[key] !== undefined && typeof n[key] !== 'boolean') throw Error('Invalid display flag');
      if (n.group !== undefined && n.rest) throw Error('Groups do not have Rest rows');
      const names = new Set();
      for (const child of n.children) {
        if (child.span && names.has(child.span)) throw Error('This span is already at this level');
        if (child.span) names.add(child.span);
        visit(child, depth + 1);
      }
      const allowed = new Set(['id', 'span', 'group', 'name', 'children', 'hidden', 'open', 'rest']);
      if (Object.keys(n).some((k) => !allowed.has(k))) throw Error('Unexpected layout state');
    }
    visit(value.main, 0);
    value.projections.forEach((n) => visit(n, 0));
    if (value.main.id !== unit || value.main.span !== unit || value.main.hidden) throw Error('The unit root is fixed');
    return clone(value);
  }

  const containmentCache = new WeakMap();
  class Tree {
    constructor(unit, paths, value) {
      this.unit = unit;
      this.paths = paths;
      this.state = value
        ? validate(unit, value)
        : { v: 7, unit, main: { id: unit, span: unit, open: true, children: [] }, projections: [] };
      this.refresh();
      // Name containment is derived once from the complete recording, never from loading/edit order.
      if (containmentCache.has(paths)) {
        this.contains = containmentCache.get(paths);
        return;
      }
      this.contains = new Map();
      for (const p of paths) {
        let q = p.parent;
        while (q >= 0 && (!p.independent || paths[q].independent)) {
          const name = paths[q].name;
          if (name !== p.name) (this.contains.get(name) || this.contains.set(name, new Set()).get(name)).add(p.name);
          q = paths[q].parent;
        }
      }
      // Reachability closes the name graph, including recursive components spread across calls.
      for (const name of this.contains.keys()) {
        const seen = new Set(),
          pending = [name];
        while (pending.length) {
          const from = pending.pop();
          for (const to of this.contains.get(from) || [])
            if (!seen.has(to)) {
              seen.add(to);
              pending.push(to);
            }
        }
        seen.delete(name);
        this.contains.set(name, seen);
      }
      containmentCache.set(paths, this.contains);
    }
    refresh() {
      this.nodes = new Map();
      this.parents = new Map();
      this.depth = new Map();
      this.analysis = new Map();
      const walk = (n, parent, depth, analysis) => {
        this.nodes.set(n.id, n);
        this.parents.set(n.id, parent);
        this.depth.set(n.id, depth);
        this.analysis.set(n.id, analysis);
        n.children.forEach((c) => walk(c, n.id, depth + 1, analysis));
      };
      walk(this.state.main, null, 0, 'main');
      this.state.projections.forEach((n) => walk(n, ROOT2, 1, n.id));
      this.baseCache = new Map();
      this.signatureCache = new Map();
    }
    get(id) {
      return this.nodes.get(isRest(id) ? id.slice(6) : id);
    }
    children(id) {
      return id === ROOT2 ? this.state.projections : this.get(id)?.children || [];
    }
    inside(id, parent) {
      for (let p = id; p != null; p = this.parents.get(p) ?? null) if (p === parent) return true;
      return false;
    }
    label(id) {
      if (id === ROOT2) return 'Projections';
      if (isRest(id)) return 'Rest of ' + this.label(id.slice(6));
      const n = this.get(id);
      return n?.name || n?.group || (n?.span === GAP ? 'Not covered by spans' : n?.span) || picked(id) || id;
    }
    frontier(id) {
      const out = [];
      const visit = (n) => {
        if (n.span) out.push(n);
        else n.children.forEach(visit);
      };
      this.children(id).forEach(visit);
      return out;
    }
    bases(id) {
      if (this.baseCache.has(id)) return this.baseCache.get(id);
      const names = new Set(this.frontier(id).map((n) => n.span));
      const base = new Set(
        [...names].filter(
          (name) =>
            ![...names].some(
              (other) => other !== name && this.contains.get(other)?.has(name) && !this.contains.get(name)?.has(other),
            ),
        ),
      );
      this.baseCache.set(id, base);
      return base;
    }
    signature(id) {
      if (this.signatureCache.has(id)) return this.signatureCache.get(id);
      const n = this.get(id),
        key = n.span ? 's:' + n.span : 'g:' + JSON.stringify([...this.bases(id)].sort());
      const parent = this.parents.get(id),
        value = (parent && parent !== ROOT2 ? this.signature(parent) + '/' : '') + key;
      this.signatureCache.set(id, value);
      return value;
    }
    rank(id) {
      const n = this.get(id);
      if (id === this.unit) return 0;
      let extra = 1;
      for (let p = this.parents.get(id); p && p !== ROOT2; p = this.parents.get(p)) {
        const parent = this.get(p);
        if (parent.span) return this.rank(p) + extra;
        if (!this.bases(p).has(n.span)) extra++;
      }
      return extra;
    }
    freshId() {
      let k = 1;
      while (this.nodes.has('n' + k)) k++;
      return 'n' + k;
    }
    create(span, parent) {
      if (parent !== ROOT2 && (!this.nodes.has(parent) || isRest(parent))) throw Error('Unknown destination');
      const existing = parent === ROOT2 ? null : this.children(parent).find((n) => n.span === span);
      if (existing) {
        existing.hidden = false;
        return existing.id;
      }
      const node = { id: this.freshId(), span, children: [] };
      this.children(parent).push(node);
      if (this.get(parent)) this.get(parent).open = true;
      this.refresh();
      return node.id;
    }
    detach(id) {
      const p = this.parents.get(id),
        list = this.children(p),
        at = list.findIndex((n) => n.id === id);
      if (at >= 0) return list.splice(at, 1)[0];
      return null;
    }
    add(ids, parent) {
      const out = [];
      for (const id of ids) {
        if (isRest(id)) {
          const n = this.get(id);
          if (n?.span) n.rest = true;
          continue;
        }
        if (this.nodes.has(id)) {
          this.get(id).hidden = false;
          out.push(id);
          continue;
        }
        const name = picked(id);
        if (name !== null) out.push(this.create(name, parent));
      }
      if (this.get(parent)) this.get(parent).open = true;
      return out;
    }
    hide(id) {
      if (isRest(id)) {
        const n = this.get(id);
        if (n) n.rest = false;
      } else if (id !== this.unit && this.get(id)) this.get(id).hidden = true;
    }
    reveal(id) {
      if (isRest(id)) {
        const n = this.get(id);
        if (n?.span) n.rest = true;
      } else if (this.get(id)) this.get(id).hidden = false;
    }
    remove(id, dissolve = true) {
      if (isRest(id)) {
        this.hide(id);
        return;
      }
      const n = this.get(id);
      if (!n || id === this.unit) return;
      const parent = this.parents.get(id),
        list = this.children(parent);
      let at = list.findIndex((c) => c.id === id);
      let promoted = [];
      if (n.group !== undefined && n.open && dissolve) {
        const bases = this.bases(id);
        const keep = (c) => {
          if (c.span) return bases.has(c.span);
          c.children = c.children.filter(keep);
          return c.children.length > 0;
        };
        promoted = n.children.filter(keep);
      }
      list.splice(at, 1);
      for (const c of promoted)
        if (parent === ROOT2 || !c.span || !list.some((x) => x.span === c.span)) list.splice(at++, 0, c);
      this.refresh();
    }
    clear(id) {
      if (this.get(id)) {
        this.get(id).children = [];
        this.get(id).rest = false;
        this.get(id).open = true;
      } else if (id === ROOT2) this.state.projections = [];
      this.refresh();
    }
    common(ids) {
      for (let p = this.parents.get(ids[0]); p != null; p = this.parents.get(p) ?? null)
        if (ids.every((id) => this.inside(id, p) || (p === ROOT2 && this.analysis.get(id) !== 'main'))) return p;
      return ROOT2;
    }
    move(id, parent, before = null) {
      if (parent !== ROOT2 && (!this.nodes.has(parent) || isRest(parent))) throw Error('Unknown destination');
      if (!this.get(id) || id === this.unit || isRest(id) || id === parent || this.inside(parent, id))
        throw Error('Choose a destination outside this subtree');
      const previousParent = this.parents.get(id);
      if (previousParent === parent && before === id) return id;
      const n = this.get(id),
        same = parent === ROOT2 ? null : this.children(parent).find((c) => c.id !== id && c.span && c.span === n.span);
      if (same) throw Error('This span is already at that level');
      this.detach(id);
      const list = this.children(parent),
        at = list.findIndex((c) => c.id === before);
      list.splice(at < 0 ? list.length : at, 0, n);
      n.hidden = false;
      if (previousParent !== parent && this.get(parent)) this.get(parent).open = true;
      this.refresh();
      return id;
    }
    merge(ids, name) {
      ids = [...new Set(ids)].filter((id) => this.get(id) && id !== this.unit && !isRest(id));
      ids = ids.filter((id) => !ids.some((other) => other !== id && this.inside(id, other)));
      if (!ids.length) return null;
      const names = ids.map((id) => this.get(id).span).filter(Boolean);
      if (new Set(names).size !== names.length) throw Error('This span is already selected at the merged level');
      if (ids.some((id) => this.analysis.get(id) === 'main') && ids.some((id) => this.analysis.get(id) !== 'main'))
        throw Error('Merge within one analysis');
      const parent = this.common(ids),
        node = { id: this.freshId(), group: name || this.label(ids[0]), open: true, children: [] };
      for (const id of ids) {
        const n = this.detach(id);
        if (n && (!n.span || !node.children.some((c) => c.span === n.span))) node.children.push(n);
      }
      this.children(parent).push(node);
      if (this.get(parent)) this.get(parent).open = true;
      this.refresh();
      return node.id;
    }
    duplicate(id, parent = ROOT2) {
      if (parent !== ROOT2 && (!this.nodes.has(parent) || isRest(parent))) throw Error('Unknown destination');
      if (!this.get(id) || id === this.unit || isRest(id)) return null;
      const n = clone(this.get(id));
      const used = new Set(this.nodes.keys());
      let k = 1;
      const assign = (node) => {
        while (used.has('n' + k)) k++;
        node.id = 'n' + k++;
        used.add(node.id);
        node.children.forEach(assign);
      };
      assign(n);
      n.hidden = false;
      this.children(parent).push(n);
      this.refresh();
      return n.id;
    }
    // Compile a selector lookup and an owner for each actual call route. Recursion re-enters the upper selector.
    plan(routes, analysis = 'main') {
      const root = analysis === 'main' ? this.unit : analysis;
      const all = [...this.nodes.values()].filter((n) => this.analysis.get(n.id) === analysis),
        byName = new Map(),
        ancestors = new Map();
      for (const n of all) {
        const chain = [];
        for (let p = n.id; p && p !== ROOT2; p = this.parents.get(p)) chain.push(p);
        ancestors.set(n.id, chain);
        if (n.span) (byName.get(n.span) || byName.set(n.span, []).get(n.span)).push(n.id);
      }
      for (const ids of byName.values())
        ids.sort((a, b) => this.rank(a) - this.rank(b) || compare(this.signature(a), this.signature(b)));
      const owners = new Array(routes.length),
        matches = new Map(all.map((n) => [n.id, []])),
        blocked = new Map(),
        selected = new Uint8Array(routes.length),
        guards = Array.from(routes, () => []);
      for (const route of routes) {
        const inherited = route.parent < 0 ? (analysis === 'main' ? root : null) : owners[route.parent];
        const candidates = [];
        for (const id of byName.get(route.name) || []) {
          if (analysis === 'main' && route.independent) continue;
          let eligible = true;
          for (let p = this.parents.get(id); p && p !== ROOT2; p = this.parents.get(p)) {
            if (p === this.unit) continue;
            const n = this.get(p);
            if (inherited && this.inside(inherited, p)) continue;
            if (n.group !== undefined && this.bases(p).has(route.name)) continue;
            eligible = false;
            break;
          }
          if (eligible) candidates.push(id);
        }
        const owner = candidates[0] || inherited;
        if (candidates.length > 1) {
          const a = candidates[0],
            b = candidates[1];
          if (this.rank(a) === this.rank(b)) throw Error('The same span is selected twice in overlapping group scopes');
          for (const id of candidates.slice(1)) blocked.set(id, a);
        }
        owners[route.id] = owner;
        if (candidates[0]) {
          matches.get(candidates[0]).push(route.id);
          selected[route.id] = 1;
          for (let p = this.parents.get(candidates[0]); p && p !== ROOT2; p = this.parents.get(p)) {
            const n = this.get(p);
            if (analysis === 'main' && p === this.unit) continue;
            if (n.group !== undefined && this.bases(p).has(route.name)) continue;
            for (let q = route.parent; q >= 0; q = routes[q].parent)
              if (
                selected[q] &&
                (n.span ? owners[q] === p : this.inside(owners[q], p) && this.bases(p).has(routes[q].name))
              ) {
                guards[route.id].push(q);
                break;
              }
          }
        }
      }
      return {
        root,
        all: all.map((n) => ({ ...n, children: n.children.map((c) => ({ id: c.id })) })),
        owners,
        ancestors,
        matches,
        blocked,
        selected,
        guards,
      };
    }
  }

  // A one-time import of old path recipes. Only the resulting explicit name tree is retained.
  function migrate(unit, old) {
    if (old?.v === 7) return validate(unit, old);
    if (!old) return new Tree(unit, []).state;
    const D = window.ViolinDefinitions,
      groups = new Map((old.groups || []).map(([id, name, inputs, more]) => [id, { name, inputs, more: more || {} }]));
    const member = new Map();
    for (const [id, g] of groups)
      for (const input of g.inputs) member.set(typeof input === 'string' ? input : input.violin || input.span, id);
    const parents = new Map(old.parents || []),
      shown = new Set(old.shown || []),
      hidden = new Set(old.skip || []),
      open = new Set(old.open || []),
      aliases = new Map(old.names || []),
      top = new Set(old.top2 || []);
    const out = { v: 7, unit, main: { id: unit, span: unit, open: true, children: [] }, projections: [] },
      made = new Map([[unit, out.main]]),
      building = new Set();
    let next = 1;
    const source = (id) => (D ? D.source(id) : id),
      scope = (id) => (D ? D.scope(id) : null);
    const natural = (id) => {
      const key = source(id),
        at = key.lastIndexOf('\u0001');
      if (at < 0) return scope(id) !== null ? ROOT2 : unit;
      return scope(id) !== null ? D.copy(key.slice(0, at), scope(id)) : key.slice(0, at);
    };
    function ensure(id) {
      if (id === ROOT2) return null;
      if (made.has(id)) return made.get(id);
      if (id === '~rest') {
        out.main.rest = true;
        return null;
      }
      const rp = D?.restParts(id);
      if (rp) {
        const n = ensure(rp[0]);
        if (n?.span) n.rest = true;
        return null;
      }
      if (building.has(id)) return null;
      building.add(id);
      const g = groups.get(id),
        key = source(id),
        name = key.split('\u0001').pop();
      let parent =
        member.get(id) ||
        parents.get(id) ||
        (top.has(id) ? ROOT2 : g ? (g.more.tree === 2 ? ROOT2 : unit) : natural(id));
      if (scope(id) !== null && source(id) === unit) parent = ROOT2;
      const p = parent === ROOT2 ? null : ensure(parent),
        list = p ? p.children : out.projections;
      let n = !g ? list.find((n) => n.span === name) : null;
      if (!n) {
        n = { id: 'n' + next++, ...(g ? { group: g.name } : { span: name }), children: [] };
        list.push(n);
      }
      made.set(id, n);
      building.delete(id);
      if (aliases.has(id)) n.name = aliases.get(id);
      if (hidden.has(id) || !shown.has(id)) n.hidden = true;
      if (open.has(id) || (!shown.has(id) && !g)) n.open = true;
      return n;
    }
    for (const id of [...shown, ...hidden, ...groups.keys()]) ensure(id);
    for (const [id, g] of groups) {
      ensure(id);
      for (const input of g.inputs) ensure(typeof input === 'string' ? input : input.violin || input.span);
    }
    // Old exact-path exclusions become actual hidden extractors in their containing scope.
    for (const [owner, paths] of old.except || []) {
      const n = ensure(owner);
      if (!n) continue;
      const parent = member.get(owner) || parents.get(owner) || natural(owner),
        p = parent === ROOT2 ? null : ensure(parent),
        list = p ? p.children : out.projections;
      for (const path of paths) {
        const name = source(path).split('\u0001').pop();
        if (!list.some((c) => c.span === name)) list.push({ id: 'n' + next++, span: name, hidden: true, children: [] });
      }
    }
    const dedupe = (n) => {
      const seen = new Map();
      n.children = n.children.filter((c) => {
        if (!c.span) return true;
        if (!seen.has(c.span)) {
          seen.set(c.span, c);
          return true;
        }
        seen.get(c.span).children.push(...c.children);
        return false;
      });
      n.children.forEach(dedupe);
    };
    dedupe(out.main);
    out.projections.forEach(dedupe);
    for (const [parent, ids] of old.order || []) {
      const list = parent === ROOT2 ? out.projections : made.get(parent)?.children;
      if (!list) continue;
      const rank = new Map(ids.map((id, k) => [made.get(id)?.id, k]));
      list.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    return validate(unit, out);
  }
  window.ViolinTree = { Tree, validate, migrate, GAP, ROOT2, rest, isRest, pick, picked };
})();
