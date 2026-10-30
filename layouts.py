"""Portable layout decoding and model validation, shared in shape with definition-model.js."""
import copy
import json
import re
from urllib.parse import quote, unquote

SEP, COPY, SCOPE = '\x01', '\x02', '\x03'
LISTS = ('shown', 'open', 'skip', 'top2')
PAIRS = ('parents', 'names')
MANY = ('order', 'except', 'bounds')


def source(r):
    return r[1:].partition(SCOPE)[2] if r.startswith(COPY) and SCOPE in r else r.removeprefix(COPY)


def scope(r):
    return r[1:].partition(SCOPE)[0] if r.startswith(COPY) and SCOPE in r else ''


def copied(path, context=''):
    return COPY + (context + SCOPE if context else '') + path


def rest_parts(r):
    if not isinstance(r, str) or not r.startswith('~rest:'):
        return None
    try:
        parts = json.loads(unquote(r[6:]))
        return parts if isinstance(parts, list) and len(parts) == 2 and all(
            isinstance(p, str) and not p.startswith('~rest:') for p in parts) else None
    except (ValueError, TypeError):
        return None


def rest(owner, span):
    return '~rest:' + quote(json.dumps([owner, span], ensure_ascii=False, separators=(',', ':')), safe="~!*'()")


def input_key(term):
    return term if isinstance(term, str) else term.get('span', term.get('violin'))


def typed(term):
    return {'violin': term} if isinstance(term, str) else term


def map_expression(expression, ref, depth=0):
    if not isinstance(expression, list) or not expression or depth > 100:
        raise ValueError('Invalid retained coverage')
    op, *args = expression
    if op == 'span' and len(args) == 1 and isinstance(args[0], str):
        return [op, ref(args[0])]
    if op == 'union' or (op in ('subtract', 'intersect') and len(args) == 2):
        return [op, *[map_expression(e, ref, depth + 1) for e in args]]
    raise ValueError('Invalid retained coverage')


def validate_tree(unit, state):
    if not isinstance(unit, str) or not unit or not isinstance(state, dict) or state.get('v') != 7 or state.get('unit') != unit:
        raise ValueError('Invalid tree layout')
    if set(state) - {'v', 'unit', 'main', 'projections'}:
        raise ValueError('Unexpected layout state')
    ids = set()
    def node(n, depth=0):
        if not isinstance(n, dict) or depth > 150 or len(ids) >= 20000:
            raise ValueError('Invalid tree node')
        if set(n) - {'id', 'span', 'group', 'name', 'children', 'open', 'hidden', 'rest'}:
            raise ValueError('Unexpected layout state')
        identity = n.get('id')
        if not isinstance(identity, str) or not identity or identity in ids or identity == '~two' or identity.startswith(('~rest:', '~pick:')):
            raise ValueError('Duplicate or invalid violin identity')
        ids.add(identity)
        if sum(k in n for k in ('span', 'group')) != 1 or not isinstance(n.get('span', n.get('group')), str) or not n.get('span', n.get('group')):
            raise ValueError('A violin needs one span or group name')
        if 'span' in n and (not n['span'] or any(ord(c) < 4 for c in n['span'])):
            raise ValueError('Invalid span name')
        if 'name' in n and not isinstance(n['name'], str):
            raise ValueError('Invalid violin label')
        for flag in ('open', 'hidden', 'rest'):
            if flag in n and not isinstance(n[flag], bool):
                raise ValueError('Invalid display flag')
        if 'group' in n and n.get('rest'):
            raise ValueError('Groups do not have Rest rows')
        children = n.get('children')
        if not isinstance(children, list):
            raise ValueError('A violin needs a child list')
        names = set()
        for child in children:
            if isinstance(child, dict) and 'span' in child:
                if child['span'] in names:
                    raise ValueError('This span is already at this level')
                names.add(child['span'])
            node(child, depth + 1)
    node(state.get('main'))
    if not isinstance(state.get('projections'), list):
        raise ValueError('Invalid projection list')
    for projection in state['projections']:
        node(projection)
    root = state['main']
    if root['id'] != unit or root.get('span') != unit or root.get('hidden'):
        raise ValueError('The unit root is fixed')
    return state


def decode_tree(doc):
    unit = doc.get('unit')
    next_id = 0
    def node(n, root=False):
        nonlocal next_id
        if not isinstance(n, dict) or set(n) - {'span', 'group', 'name', 'children', 'open', 'hidden', 'rest'}:
            raise ValueError('Invalid tree node')
        next_id += 1
        identity = unit if root else f'n{next_id-1}'
        return {**n, 'id': identity, 'children': [node(c) for c in n.get('children', [])]}
    state = {'v': 7, 'unit': unit, 'main': node(doc.get('tree'), True),
             'projections': [node(n) for n in doc.get('projections', [])]}
    return {'unit': unit, 'name': doc.get('name', 'Imported layout'), 'layout': validate_tree(unit, state)}


def decode(value):
    doc = copy.deepcopy(value)
    if not isinstance(doc, dict):
        raise ValueError('Expected a layout object')
    if doc.get('format') == 'violinoscope-layout' and doc.get('version') == 4:
        return decode_tree(doc)
    if isinstance(doc.get('layout'), dict) and doc['layout'].get('v') == 7:
        validate_tree(doc.get('unit'), doc['layout'])
        return doc
    if doc.get('format') == 'violinoscope-layout':
        if doc.get('version') not in (1, 2, 3) or not isinstance(doc.get('paths'), list):
            raise ValueError('Unsupported layout format')
        paths = []
        for path in doc['paths']:
            if not isinstance(path, list) or not path or path[0] != doc.get('unit') or any(
                    not isinstance(n, str) or any(c in n for c in (SEP, COPY, SCOPE)) for n in path):
                raise ValueError('Invalid span path')
            paths.append(SEP.join(path))

        def ref(r):
            remainder = rest_parts(r)
            if remainder:
                return rest(*map(ref, remainder))
            match = re.fullmatch(r'([sp])(?:([a-zA-Z0-9]+):)?(\d+)', r) if isinstance(r, str) else None
            if not match:
                return r
            index = int(match[3])
            if index >= len(paths):
                raise ValueError('Unknown span path')
            return copied(paths[index], match[2] or '') if match[1] == 'p' else paths[index]

        def terms(values):
            out = []
            for value in values:
                value = typed(value)
                term = {k: ref(v) if k in ('span', 'violin') else v for k, v in value.items()}
                if 'cuts' in term:
                    term['cuts'] = [map_expression(e, ref) for e in term['cuts']]
                out.append(term)
            return out

        state = {'v': {1: 4, 2: 5, 3: 6}[doc['version']]}
        for key in LISTS:
            state[key] = list(map(ref, doc.get(key, [])))
        for key in PAIRS:
            state[key] = [[ref(a), b if key == 'names' else ref(b)] for a, b in doc.get(key, {}).items()]
        for key in MANY:
            state[key] = [[ref(a), list(map(ref, b))] for a, b in doc.get(key, {}).items()]
        state['retained'] = [[ref(a), [map_expression(e, ref) for e in b]] for a, b in doc.get('retained', {}).items()]
        state['definitions'] = [[ref(a), terms(b)] for a, b in doc.get('definitions', {}).items()]
        state['groups'] = []
        for group in doc.get('groups', []):
            more = {'tree': 2, 'scope': group.get('scope', '')} if group.get('tree') == 'projections' else {}
            if group.get('match'):
                more['match'] = {**group['match'], 'under': ref(group['match']['under'])}
            state['groups'].append([group['id'], group['name'], terms(group.get('inputs', group.get('parts', []))), more])
        doc = {'unit': doc.get('unit'), 'name': doc.get('name', 'Imported layout'), 'layout': state}
    unit, state = doc.get('unit'), doc.get('layout')
    if not isinstance(unit, str) or not unit or not isinstance(state, dict) or state.get('v', 1) not in range(1, 7):
        raise ValueError('Unsupported layout file')
    groups = {}
    for group in state.get('groups', []):
        if (not isinstance(group, list) or len(group) < 3 or not isinstance(group[0], str)
                or not re.fullmatch(r'g\d+', group[0]) or group[0] == unit or not isinstance(group[1], str)
                or not isinstance(group[2], list) or group[0] in groups):
            raise ValueError('Invalid violin definition')
        groups[group[0]] = group
    # The old nesting relation becomes an ordinary owned violin input.
    for g in groups.values():
        more = g[3] if len(g) > 3 else {}
        parent = more.pop('parent', None)
        if parent in groups:
            into = groups[parent]
            keys = set(map(input_key, g[2]))
            into[2][:] = [m for m in into[2] if input_key(m) not in keys]
            if g[0] not in map(input_key, into[2]):
                into[2].append({'violin': g[0]})
        elif parent:
            state['parents'] = [[a, b] for a, b in state.get('parents', []) if a != g[0]] + [[g[0], parent]]
    for g in groups.values():
        g[2][:] = list(map(typed, g[2]))
    state['definitions'] = [[node, list(map(typed, inputs))] for node, inputs in state.get('definitions', [])]

    def is_source(r):
        return isinstance(r, str) and (source(r) == unit or source(r).startswith(unit + SEP))

    def valid(r):
        if not isinstance(r, str):
            return False
        remainder = rest_parts(r)
        if remainder:
            return all(map(valid, remainder))
        return r in groups or r in ('~root', '~two', '~rest', '_all') or (
            is_source(r) and (not r.startswith(COPY) or re.fullmatch(r'[a-zA-Z0-9]*', scope(r)) is not None))

    def refs(items):
        if not isinstance(items, list) or not all(map(valid, items)):
            raise ValueError('Invalid definition reference')

    recipes = {g[0]: g[2] for g in groups.values()}
    for node, inputs in state['definitions']:
        if not is_source(node) or source(node) == unit or node in recipes:
            raise ValueError('Invalid source definition')
        recipes[node] = inputs
    for inputs in recipes.values():
        for term in inputs:
            if (not isinstance(term, dict) or set(term) - {'span', 'violin', 'cuts'}
                    or int('span' in term) + int('violin' in term) != 1 or not isinstance(input_key(term), str)
                    or ('cuts' in term and (not isinstance(term['cuts'], list) or 'span' not in term))):
                raise ValueError('Invalid definition input')
            if 'span' in term and not is_source(term['span']):
                raise ValueError('A source input requires a recorded span')
        refs(list(map(input_key, inputs)))
    for key in LISTS:
        refs(state.get(key, []))
    for key in PAIRS + MANY:
        for a, b in state.get(key, []):
            refs([a])
            if key == 'names':
                if not isinstance(b, str):
                    raise ValueError('Invalid violin name')
            else:
                refs(b if key in MANY else [b])
    for key in PAIRS + MANY + ('retained', 'definitions'):
        keys = [entry[0] for entry in state.get(key, [])]
        if len(set(keys)) != len(keys):
            raise ValueError('Duplicate layout entry')

    def expression_ref(r):
        if not is_source(r):
            raise ValueError('Retained coverage requires a recorded span')
        refs([r])
        return r
    for node, cuts in state.get('retained', []):
        refs([node])
        if node == unit and cuts:
            raise ValueError('The unit source is fixed')
        if not isinstance(cuts, list):
            raise ValueError('Invalid retained coverage')
        for cut in cuts:
            map_expression(cut, expression_ref)
    for inputs in recipes.values():
        for term in inputs:
            for cut in term.get('cuts', []):
                map_expression(cut, expression_ref)
    for key in ('except', 'bounds'):
        for node, values in state.get(key, []):
            if node == unit:
                raise ValueError('The unit source is fixed')
            if not all(map(is_source, values)):
                raise ValueError('Exclusions and bounds require recorded spans')
    if unit in state.get('skip', []):
        raise ValueError('The unit source is fixed')

    def tree(node):
        parts = rest_parts(node)
        if parts:
            return tree(parts[0])
        g = groups.get(node)
        return 2 if node.startswith(COPY) or node == '~two' or (g and len(g) > 3 and g[3].get('tree') == 2) else 1
    owners = {}
    for node, inputs in recipes.items():
        for term in inputs:
            member = input_key(term)
            if tree(node) != tree(member):
                raise ValueError('An input belongs to another analysis')
            if term.get('span') == node:
                continue
            if member in ('~root', '~two', '~rest') or rest_parts(member) or source(member) == unit:
                raise ValueError('A root or remainder cannot be a merge input')
            if member in owners:
                raise ValueError('A violin has more than one owner')
            owners[member] = node
    visiting, done = set(), set()

    def visit(node):
        if node in visiting:
            raise ValueError('Layout contains a definition cycle')
        if node in done:
            return
        visiting.add(node)
        for term in recipes.get(node, []):
            if term.get('violin') in recipes:
                visit(term['violin'])
        visiting.remove(node)
        done.add(node)
    for node in recipes:
        visit(node)
    parents = dict(state.get('parents', []))
    for node, parent in parents.items():
        if node == unit or tree(node) != tree(parent):
            raise ValueError('Invalid analysis placement')
    for node, parent in owners.items():
        if node in parents and parents[node] != parent:
            raise ValueError('A violin has conflicting placement and membership')
        parents[node] = parent
    for group in groups.values():
        more = group[3] if len(group) > 3 else {}
        if 'scope' in more and (not isinstance(more['scope'], str) or not re.fullmatch(r'[a-zA-Z0-9]*', more['scope'])):
            raise ValueError('Invalid analysis identity')
        if more.get('match'):
            refs([more['match'].get('under')])
            if not isinstance(more['match'].get('text'), str):
                raise ValueError('Invalid span selector')
    for start in parents:
        seen, node = set(), start
        while node:
            if node in seen:
                raise ValueError('Layout contains a placement cycle')
            seen.add(node)
            raw = source(node)
            natural = raw.rpartition(SEP)[0] if SEP in raw else None
            if natural and node.startswith(COPY):
                natural = copied(natural, scope(node))
            node = parents.get(node, natural)

    def basis(node):
        if node not in recipes:
            return [source(node)] if is_source(node) else []
        return [path for term in recipes[node] for path in ([source(term['span'])] if 'span' in term else basis(term['violin']))]
    for node, parent in state.get('parents', []):
        if is_source(parent) and parent != unit:
            containers = basis(parent)
            if any(not any(p == q or p.startswith(q + SEP) for q in containers) for p in basis(node)):
                raise ValueError('The containing violin does not cover its child sources')
    for owner, inputs in recipes.items():
        for term in inputs:
            child = term.get('span')
            if child and child != owner and child in recipes:
                containers = basis(owner)
                if any(not any(p == q or p.startswith(q + SEP) for q in containers) for p in basis(child)):
                    raise ValueError('The edited source violin uses spans outside this recipe; restore its source input first')
    state['next'] = max(state.get('next', 1), max((int(g[1:]) + 1 for g in groups), default=1))
    return {'unit': unit, 'name': doc.get('name', 'Default'), 'layout': state}
