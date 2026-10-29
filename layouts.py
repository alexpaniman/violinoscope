"""Decode portable layout files without needing a browser or JavaScript runtime."""
import copy
import re

SEP, COPY, SCOPE = '\x01', '\x02', '\x03'


def source(r):
    return r[1:].partition(SCOPE)[2] if r.startswith(COPY) and SCOPE in r else r.removeprefix(COPY)


def scope(r):
    return r[1:].partition(SCOPE)[0] if r.startswith(COPY) and SCOPE in r else ''


def copied(path, context=''):
    return COPY + (context + SCOPE if context else '') + path

LISTS = ('shown', 'open', 'skip', 'top2')
PAIRS = ('parents', 'names')
MANY = ('order', 'except', 'bounds')


def map_expression(expression, ref, depth=0):
    if not isinstance(expression, list) or not expression or depth > 100:
        raise ValueError('Invalid retained coverage')
    op, *args = expression
    if op == 'span' and len(args) == 1 and isinstance(args[0], str):
        return [op, ref(args[0])]
    if op == 'union' or (op in ('subtract', 'intersect') and len(args) == 2):
        return [op, *[map_expression(e, ref, depth + 1) for e in args]]
    raise ValueError('Invalid retained coverage')


def decode(value):
    doc = copy.deepcopy(value)
    if not isinstance(doc, dict):
        raise ValueError('Expected a layout object')
    if doc.get('format') == 'violinoscope-layout':
        if doc.get('version') not in (1, 2) or not isinstance(doc.get('paths'), list):
            raise ValueError('Unsupported layout format')
        paths = []
        for path in doc['paths']:
            if not isinstance(path, list) or not path or path[0] != doc.get('unit') or any(
                    not isinstance(n, str) or SEP in n or COPY in n or SCOPE in n for n in path):
                raise ValueError('Invalid span path')
            paths.append(SEP.join(path))

        def ref(r):
            match = re.fullmatch(r'([sp])(?:([a-z0-9]+):)?(\d+)', r) if isinstance(r, str) else None
            if not match:
                return r
            index = int(match[3])
            if index >= len(paths):
                raise ValueError('Unknown span path')
            return copied(paths[index], match[2] or '') if match[1] == 'p' else paths[index]

        state = {'v': 5 if doc['version'] == 2 else 4}
        for key in LISTS:
            state[key] = list(map(ref, doc.get(key, [])))
        for key in PAIRS:
            state[key] = [[ref(a), b if key == 'names' else ref(b)] for a, b in doc.get(key, {}).items()]
        for key in MANY:
            state[key] = [[ref(a), list(map(ref, b))] for a, b in doc.get(key, {}).items()]
        state['retained'] = [[ref(a), [map_expression(e, ref) for e in b]] for a, b in doc.get('retained', {}).items()]
        state['groups'] = []
        for group in doc.get('groups', []):
            more = {}
            if group.get('tree') == 'projections':
                more['tree'] = 2
                more['scope'] = group.get('scope', '')
            if group.get('match'):
                more['match'] = {**group['match'], 'under': ref(group['match']['under'])}
            state['groups'].append([group['id'], group['name'], list(map(ref, group['parts'])), more])
        doc = {'unit': doc.get('unit'), 'name': doc.get('name', 'Imported layout'), 'layout': state}
    unit, state = doc.get('unit'), doc.get('layout')
    if not isinstance(unit, str) or not unit or not isinstance(state, dict) or state.get('v', 1) not in (1, 2, 3, 4, 5):
        raise ValueError('Unsupported layout file')
    groups = {}
    for group in state.get('groups', []):
        if (not isinstance(group, list) or len(group) < 3 or not re.fullmatch(r'g\d+', group[0])
                or not isinstance(group[1], str) or not isinstance(group[2], list) or group[0] in groups):
            raise ValueError('Invalid merged violin')
        groups[group[0]] = group[2]

    def valid(r):
        if not isinstance(r, str):
            return False
        key = source(r)
        return r in groups or r in ('~root', '~two', '~rest', '_all') or key == unit or key.startswith(unit + SEP)

    def refs(items):
        if not isinstance(items, list) or not all(map(valid, items)):
            raise ValueError('Invalid span reference')

    for key in LISTS:
        refs(state.get(key, []))
    def expression_ref(r):
        refs([r])
        if r in groups or r.startswith('~'):
            raise ValueError('Retained coverage requires a recorded span')
        return r
    for node, cuts in state.get('retained', []):
        refs([node])
        if not isinstance(cuts, list):
            raise ValueError('Invalid retained coverage')
        for cut in cuts:
            map_expression(cut, expression_ref)
    for key in PAIRS + MANY:
        for a, b in state.get(key, []):
            refs([a])
            if key == 'names':
                if not isinstance(b, str):
                    raise ValueError('Invalid violin name')
            else:
                refs(b if key in MANY else [b])
    # Normalize the legacy nesting relation before validating ownership.
    entries = {g[0]: g for g in state.get('groups', [])}
    for g in entries.values():
        more = g[3] if len(g) > 3 else {}
        parent = more.pop('parent', None)
        if not parent:
            continue
        if parent in entries:
            into = entries[parent]
            into[2][:] = [m for m in into[2] if m not in g[2]]
            if g[0] not in into[2]:
                into[2].append(g[0])
        else:
            state['parents'] = [[a, b] for a, b in state.get('parents', []) if a != g[0]]
            state['parents'].append([g[0], parent])
    owners = {}
    for group, members in groups.items():
        refs(members)
        for member in members:
            if member in ('~root', '~two', '~rest') or source(member) == unit:
                raise ValueError('A root or remainder cannot be a merge input')
            if member in owners:
                raise ValueError('A violin has more than one owner')
            owners[member] = group
    visiting, done = set(), set()

    def visit(node):
        if node in visiting:
            raise ValueError('Layout contains a definition cycle')
        if node in done:
            return
        visiting.add(node)
        for member in groups.get(node, []):
            if member in groups:
                visit(member)
        visiting.remove(node)
        done.add(node)

    for group in groups:
        visit(group)
    parents = dict(state.get('parents', []))
    for node, parent in owners.items():
        if node in parents and parents[node] != parent:
            raise ValueError('A violin has conflicting placement and membership')
        parents[node] = parent
    for group in state.get('groups', []):
        more = group[3] if len(group) > 3 else {}
        if 'scope' in more and not re.fullmatch(r'[a-zA-Z0-9]*', more['scope']):
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
    state['next'] = max(state.get('next', 1), max((int(g[1:]) + 1 for g in groups), default=1))
    return {'unit': unit, 'name': doc.get('name', 'Default'), 'layout': state}
