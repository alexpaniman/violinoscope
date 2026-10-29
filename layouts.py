"""Decode portable layout files without needing a browser or JavaScript runtime."""
import copy
import re

SEP, COPY = '\x01', '\x02'
LISTS = ('shown', 'open', 'skip', 'top2')
PAIRS = ('parents', 'names')
MANY = ('order', 'except')


def decode(value):
    doc = copy.deepcopy(value)
    if not isinstance(doc, dict):
        raise ValueError('Expected a layout object')
    if doc.get('format') == 'violinoscope-layout':
        if doc.get('version') != 1 or not isinstance(doc.get('paths'), list):
            raise ValueError('Unsupported layout format')
        paths = []
        for path in doc['paths']:
            if not isinstance(path, list) or not path or path[0] != doc.get('unit') or any(
                    not isinstance(n, str) or SEP in n or COPY in n for n in path):
                raise ValueError('Invalid span path')
            paths.append(SEP.join(path))

        def ref(r):
            match = re.fullmatch(r'([sp])(\d+)', r) if isinstance(r, str) else None
            if not match:
                return r
            index = int(match[2])
            if index >= len(paths):
                raise ValueError('Unknown span path')
            return (COPY if match[1] == 'p' else '') + paths[index]

        state = {'v': 4}
        for key in LISTS:
            state[key] = list(map(ref, doc.get(key, [])))
        for key in PAIRS:
            state[key] = [[ref(a), b if key == 'names' else ref(b)] for a, b in doc.get(key, {}).items()]
        for key in MANY:
            state[key] = [[ref(a), list(map(ref, b))] for a, b in doc.get(key, {}).items()]
        state['groups'] = []
        for group in doc.get('groups', []):
            more = {}
            if group.get('tree') == 'projections':
                more['tree'] = 2
            if group.get('match'):
                more['match'] = {**group['match'], 'under': ref(group['match']['under'])}
            state['groups'].append([group['id'], group['name'], list(map(ref, group['parts'])), more])
        doc = {'unit': doc.get('unit'), 'name': doc.get('name', 'Imported layout'), 'layout': state}
    unit, state = doc.get('unit'), doc.get('layout')
    if not isinstance(unit, str) or not unit or not isinstance(state, dict) or state.get('v', 1) not in (1, 2, 3, 4):
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
        key = r.removeprefix(COPY)
        return r in groups or r in ('~root', '~two', '~rest', '_all') or key == unit or key.startswith(unit + SEP)

    def refs(items):
        if not isinstance(items, list) or not all(map(valid, items)):
            raise ValueError('Invalid span reference')

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
    parents = dict(state.get('parents', []))
    for group, members in groups.items():
        refs(members)
        for member in members:
            parents[member] = group
    for start in parents:
        seen, node = set(), start
        while node:
            if node in seen:
                raise ValueError('Layout contains a cycle')
            seen.add(node)
            node = parents.get(node, node.rpartition(SEP)[0] if SEP in node else None)
    state['next'] = max(state.get('next', 1), max((int(g[1:]) + 1 for g in groups), default=1))
    return {'unit': unit, 'name': doc.get('name', 'Default'), 'layout': state}
