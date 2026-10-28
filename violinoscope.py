#!/usr/bin/env python3
"""Builds an interactive explorer of where traced work spends its time, from Wilson / OpenTelemetry spans.

Inputs (any mix, each optionally named as NAME=PATH to become a dataset). Each input is a run: the page lays runs
out one after another in the order given, each on its own clock, so runs from different days or machines never
look concurrent:
  - OTLP JSON: an ExportTraceServiceRequest object, or one per line (the OpenTelemetry collector's file exporter);
  - Jaeger JSON: the UI's or the query API's {"data": [traces]};
  - protobuf JSON lines: one span per line, as Wilson's test uploader dumps them;
  - --jaeger URL: traces fetched from a Jaeger query service.

A profile (profiles/*.json) says which span is the root of one unit of work (a compilation for KQP) and how
span names map to the parts shown. The output is a directory with index.html and its data; open it from disk
or serve it. Standard library only.

  violinoscope.py suite=spans/*.jsonl tpc=tpc_otlp.json -o out/
  violinoscope.py old=before.jsonl new=after.jsonl --run-label old="build a1930a8" --run-label new="build fcd8251" -o out/
  violinoscope.py --jaeger http://jaeger:16686 --service ydb --lookback 2h -o out/
"""
import argparse
import base64
import glob
import gzip
import hashlib
import heapq
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_UNITS = 500       # time frames sent to the page are on a 1/PAGE_UNITS grid of each unit's span
CHUNK = 200            # units per span tree file
TEXT_LIMIT = 4000      # characters of query text kept per unit, with --with-text

OTLP_STATUS_ERROR = {2, 'STATUS_CODE_ERROR'}


# ---------------------------------------------------------------------------------------------------------------
# Reading spans. Every format becomes dicts with: trace, id, parent, name, start, end (ns), attrs, error, message.

def b64_or_hex(value):
    if not value:
        return ''
    if re.fullmatch(r'[0-9a-fA-F]+', value) and len(value) in (16, 32):
        return value.lower()
    try:
        return base64.b64decode(value).hex()
    except ValueError:
        return value


def otlp_value(v):
    for key in ('stringValue', 'boolValue', 'doubleValue'):
        if key in v:
            return v[key]
    if 'intValue' in v:
        return int(v['intValue'])
    if 'arrayValue' in v:
        return [otlp_value(x) for x in v['arrayValue'].get('values', [])]
    return None


def from_otlp_span(s):
    status = s.get('status') or {}
    return {
        'trace': b64_or_hex(s.get('traceId', '')), 'id': b64_or_hex(s.get('spanId', '')),
        'parent': b64_or_hex(s.get('parentSpanId', '')), 'name': s.get('name', ''),
        'start': int(s.get('startTimeUnixNano', 0)), 'end': int(s.get('endTimeUnixNano', 0)),
        'attrs': {a['key']: otlp_value(a.get('value', {})) for a in s.get('attributes', [])},
        'error': status.get('code') in OTLP_STATUS_ERROR, 'message': status.get('message', ''),
        # Links to other spans, with what each means: depends_on, follows_from, or nothing said.
        'links': [(b64_or_hex(l.get('spanId', '')), next((otlp_value(a.get('value', {})) for a in l.get('attributes', [])
                                                          if a.get('key') == 'ydb.link.relation'), ''))
                  for l in s.get('links', [])],
    }


def from_jaeger_trace(trace):
    for s in trace.get('spans', []):
        parent = next((r['spanID'] for r in s.get('references', []) if r.get('refType') == 'CHILD_OF'), '')
        tags = {t['key']: t.get('value') for t in s.get('tags', [])}
        start = int(s['startTime']) * 1000
        error = tags.get('error') in (True, 'true') or tags.get('otel.status_code') == 'ERROR'
        yield {
            'trace': s['traceID'].lower().rjust(32, '0'), 'id': s['spanID'].lower(), 'parent': parent.lower(),
            'name': s.get('operationName', ''), 'start': start, 'end': start + int(s.get('duration', 0)) * 1000,
            'attrs': tags, 'error': error, 'message': tags.get('otel.status_description', ''),
        }


def spans_from_document(doc):
    if isinstance(doc, dict) and 'resourceSpans' in doc:
        for rs in doc['resourceSpans']:
            for ss in rs.get('scopeSpans', rs.get('instrumentationLibrarySpans', [])):
                for s in ss.get('spans', []):
                    yield from_otlp_span(s)
    elif isinstance(doc, dict) and 'data' in doc and isinstance(doc['data'], list):
        for trace in doc['data']:
            yield from from_jaeger_trace(trace)
    elif isinstance(doc, dict) and 'spanId' in doc:
        yield from_otlp_span(doc)
    elif isinstance(doc, list):
        for item in doc:
            yield from spans_from_document(item)


def read_file(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt') as f:
        head = f.read(1 << 16)
        f.seek(0)
        lines = '\n' in head.strip() and head.lstrip().startswith('{') and _first_line_parses(head)
        if lines:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    doc = json.loads(line)
                except json.JSONDecodeError:
                    continue  # a truncated last line
                yield from spans_from_document(doc)
        else:
            yield from spans_from_document(json.load(f))


def _first_line_parses(head):
    try:
        json.loads(head.split('\n', 1)[0])
        return True
    except json.JSONDecodeError:
        return False


def fetch_jaeger(url, service, operation, lookback_s, limit):
    end = int(time.time() * 1e6)
    query = {'service': service, 'limit': limit, 'start': end - int(lookback_s * 1e6), 'end': end}
    if operation:
        query['operation'] = operation
    request = url.rstrip('/') + '/api/traces?' + urllib.parse.urlencode(query)
    print(f'fetching {request}', file=sys.stderr)
    with urllib.request.urlopen(request, timeout=600) as r:
        doc = json.load(r)
    traces = doc.get('data', [])
    if len(traces) >= limit:
        print(f'warning: got {len(traces)} traces, the --limit; there may be more', file=sys.stderr)
    return spans_from_document(doc)


# ---------------------------------------------------------------------------------------------------------------
# Intervals.

def merge(intervals):
    out = []
    for s, e in sorted(intervals):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def clip(intervals, lo, hi):
    return [(max(s, lo), min(e, hi)) for s, e in intervals if min(e, hi) > max(s, lo)]


def length(merged):
    return sum(e - s for s, e in merged)


def subtract(merged, taken):
    out, j = [], 0
    for s, e in merged:
        at = s
        while j < len(taken) and taken[j][1] <= at:
            j += 1
        k = j
        while k < len(taken) and taken[k][0] < e:
            if taken[k][0] > at:
                out.append([at, taken[k][0]])
            at = max(at, taken[k][1])
            k += 1
        if at < e:
            out.append([at, e])
    return out


def complement(merged, lo, hi):
    return subtract([[lo, hi]], merged)


# ---------------------------------------------------------------------------------------------------------------
# A profile: the root span of a unit of work and the matchers for parts and counts.

class Matcher:
    def __init__(self, spec):
        self.names = set(spec.get('names', []))
        self.prefix = spec.get('prefix')
        self.not_suffix = spec.get('not_suffix')
        self.all = spec.get('all', False)

    def __call__(self, name):
        if self.all:
            return True
        if name in self.names:
            return True
        if self.prefix and name.startswith(self.prefix):
            return not (self.not_suffix and name.endswith(self.not_suffix))
        return False


class Profile:
    def __init__(self, path):
        p = json.load(open(path))
        self.raw = p
        self.root = p['root']
        self.columns = p['columns']
        self.index = {c['id']: i for i, c in enumerate(self.columns)}
        self.depth = {}
        for c in self.columns:
            d, parent = 0, c.get('parent')
            while parent:
                d, parent = d + 1, self.columns[self.index[parent]].get('parent')
            self.depth[c['id']] = d
        self.direct = {c['id']: Matcher(c['match']) for c in self.columns
                       if 'names' in c['match'] or 'prefix' in c['match']}
        self.counts = [(c, Matcher(c['match'])) for c in p.get('counts', [])]
        self.partition = p.get('partition', [])
        self.priority = p.get('partition_priority', [x['id'] for x in self.partition])
        text = p.get('query_text', {})
        self.text_key = text.get('attribute')
        self.label_regex = re.compile(text['label_regex']) if text.get('label_regex') else None
        self.attributes = p.get('attributes', {})
        self.failure_span = p.get('failure', {}).get('detail_span')
        self.containers = set(p.get('containers', []))


def fingerprint(text):
    t = '\n'.join(line for line in text.split('\n') if not line.lstrip().startswith('--'))
    t = re.sub(r"'(?:[^'\\]|\\.)*'", '?', t)
    t = re.sub(r'"(?:[^"\\]|\\.)*"', '?', t)
    t = re.sub(r'\b\d+(?:\.\d+)?\b', '?', t)
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return hashlib.sha1(t.encode()).hexdigest()[:12]


def failure_reason(message):
    """The innermost error of a reply's issues (warnings have severity 2; no severity means fatal)."""
    reasons = []
    for line in message.split('\n'):
        line = line.strip()
        m = re.match(r'message: "(.*)"$', line)
        if m:
            reasons.append([m.group(1), 0])
        m = re.match(r'severity: (\d)', line)
        if m and reasons:
            reasons[-1][1] = int(m.group(1))
    errors = [r for r, severity in reasons if severity < 2]
    return errors[-1] if errors else (message.strip().split('\n')[0][:200] if message else '')


# ---------------------------------------------------------------------------------------------------------------
# One unit of work (one root span and everything under it).

def analyze_unit(profile, trace_spans, root, children):
    lo, hi = root['start'], root['end']
    total = hi - lo
    inside, stack = [], [(root, -1)]
    while stack:
        s, parent_row = stack.pop()
        inside.append((s, parent_row))
        row = len(inside) - 1
        for k in sorted(children[s['id']], key=lambda x: x['start'], reverse=True):
            stack.append((k, row))
    spans = [s for s, _ in inside]

    frames = {}
    for c in profile.columns:
        m = c['match']
        if c['id'] in profile.direct:
            matcher = profile.direct[c['id']]
            frames[c['id']] = merge(clip([(s['start'], s['end']) for s in spans if matcher(s['name'])], lo, hi))
        elif 'after_nth' in m:
            spec = m['after_nth']
            anchors = sorted(s['start'] for s in spans if s['name'] == spec['anchor'])
            names = set(spec['names'])
            picked = [(s['start'], s['end']) for s in spans
                      if s['name'] in names and len(anchors) >= spec['n'] and s['start'] >= anchors[spec['n'] - 1]]
            frames[c['id']] = merge(clip(picked, lo, hi))
    for c in profile.columns:
        m = c['match']
        if 'union_of' in m:
            frames[c['id']] = merge([iv for cid in m['union_of'] for iv in frames[cid]])
    for c in profile.columns:
        m = c['match']
        if 'uncovered_by' in m:
            frames[c['id']] = complement(merge([iv for cid in m['uncovered_by'] for iv in frames[cid]]), lo, hi)

    record = {'total_ms': total / 1e6, 'start_ns': lo, 'share': [], 'frames': [], 'part': [], 'counts': []}
    for c in profile.columns:
        merged = frames[c['id']]
        record['share'].append(length(merged) / total if total > 0 else 0.0)
        record['frames'].append(page_frames(merged, lo, total))
    if profile.partition:
        sources = {p['id']: merge([iv for cid in p['from'] for iv in frames[cid]]) for p in profile.partition}
        taken, own = [], {}
        for pid in profile.priority:
            piece = subtract(sources[pid], taken)
            own[pid] = length(piece) / total if total > 0 else 0.0
            taken = merge(taken + piece)
        record['part'] = [own[p['id']] for p in profile.partition]
    record['counts'] = [sum(1 for s in spans if matcher(s['name'])) for _, matcher in profile.counts]
    record['seen'] = [1 if frames[c['id']] else 0 for c in profile.columns]

    # Which part owns each span: the deepest directly matched column among the span and its ancestors.
    direct_col = []
    for s, _ in inside:
        best = -1
        for cid, matcher in profile.direct.items():
            if matcher(s['name']) and (best < 0 or profile.depth[cid] > profile.depth[profile.columns[best]['id']]):
                best = profile.index[cid]
        direct_col.append(best)
    owner = []
    for row, (s, parent_row) in enumerate(inside):
        owner.append(direct_col[row] if direct_col[row] >= 0 else (owner[parent_row] if parent_row >= 0 else -1))
    # Self time: a span's length less what its synchronous children cover. Asynchronous children run beside it, as
    # on a separate track in Perfetto, so they take nothing from it.
    covered = [[] for _ in inside]
    for row, (s, parent_row) in enumerate(inside):
        if parent_row >= 0 and s['attrs'].get('ydb.flow') != 'async':
            covered[parent_row].append((s['start'], s['end']))
    by_name = {}
    for row, (s, _) in enumerate(inside):
        key = (s['name'], owner[row])
        entry = by_name.setdefault(key, [0, 0, 0])
        entry[0] += 1
        entry[1] += s['end'] - s['start']
        entry[2] += (s['end'] - s['start']) - length(merge(clip(covered[row], s['start'], s['end'])))
    record['names'] = by_name
    # Flags: 1 async, 2 error; the bits above hold the owning part plus one.
    record['tree'] = [(s['name'], parent_row, (s['start'] - lo) // 1000, (s['end'] - s['start']) // 1000,
                       (1 if s['attrs'].get('ydb.flow') == 'async' else 0) | (2 if s['error'] else 0) | ((owner[row] + 1) << 2))
                      for row, (s, parent_row) in enumerate(inside)]
    # Links between spans of the compilation, as rows: from, to, and 1 for depends_on, 2 for follows_from, 0 else.
    row_of = {s['id']: row for row, (s, _) in enumerate(inside)}
    record['links'] = [x for row, (s, _) in enumerate(inside) for to, rel in s.get('links', []) if to in row_of
                       for x in (row, row_of[to], {'depends_on': 1, 'follows_from': 2}.get(rel, 0))]
    return record


def page_frames(merged, lo, total):
    """Frames on a 1/PAGE_UNITS grid of the unit, delta-encoded: gap since the previous frame's end, then length."""
    if total <= 0:
        return []
    grid = []
    for s, e in merged:
        a = int((s - lo) * PAGE_UNITS // total)
        b = max(a + 1, -(-(e - lo) * PAGE_UNITS // total))
        if grid and a <= grid[-1][1]:
            grid[-1][1] = max(grid[-1][1], b)
        else:
            grid.append([a, b])
    out, at = [], 0
    for a, b in grid:
        out += [a - at, b - a]
        at = b
    return out


def attribute(profile, spans, which):
    spec = profile.attributes.get(which)
    if not spec:
        return None
    for s in spans:
        if s['name'] == spec['span'] and spec['key'] in s['attrs']:
            return s['attrs'][spec['key']]
    return None


# ---------------------------------------------------------------------------------------------------------------

def build(args):
    profile = Profile(args.profile)
    sources = []
    for item in args.inputs:
        name, _, pattern = item.rpartition('=') if '=' in item and not os.path.exists(item) else ('', '', item)
        paths = sorted(glob.glob(pattern)) or [pattern]
        expanded = []
        for p in paths:
            expanded += sorted(os.path.join(p, f) for f in os.listdir(p)) if os.path.isdir(p) else [p]
        sources.append((name or os.path.splitext(os.path.basename(pattern.rstrip('/')))[0], expanded))
    if args.jaeger:
        sources.append(('jaeger', None))

    records, failures = [], []
    unmatched = Counter()
    seen_units = set()
    for dataset, paths in sources:
        by_trace = defaultdict(dict)
        stream = (fetch_jaeger(args.jaeger, args.service, args.operation, args.lookback, args.limit) if paths is None
                  else (s for p in paths for s in read_file(p)))
        n_spans = 0
        for s in stream:
            by_trace[s['trace']][s['id']] = s
            n_spans += 1
        units = 0
        for trace_id, spans_by_id in by_trace.items():
            spans = list(spans_by_id.values())
            children = defaultdict(list)
            for s in spans:
                children[s['parent']].append(s)
            text = next((s['attrs'][profile.text_key] for s in spans if profile.text_key and profile.text_key in s['attrs']), '')
            text = text if isinstance(text, str) else ''
            group, label = None, None
            if profile.label_regex and text:
                m = profile.label_regex.search(text)
                if m:
                    group, label = m.groupdict().get('group'), m.groupdict().get('label')
            if args.skip_text and re.search(args.skip_text, text or ''):
                continue
            fp = fingerprint(text) if text else ''
            database = attribute(profile, spans, 'database')
            for root in (s for s in spans if s['name'] == profile.root):
                key = (dataset, trace_id, root['id'])
                if key in seen_units:
                    continue
                seen_units.add(key)
                units += 1
                fallback = {'database': database or dataset, 'dataset': dataset}.get(args.group_by, dataset)
                base = {'dataset': dataset, 'group': (group if args.group_by == 'label' else None) or fallback,
                        'label': label or (fp[:8] or root['id'][:8]),
                        'trace': trace_id, 'fp': fp, 'db': database or ''}
                if root['error']:
                    detail = next((s for s in spans if s['name'] == profile.failure_span), root)
                    failures.append(dict(base, reason=failure_reason(detail['message'] or root['message'])))
                    continue
                rec = analyze_unit(profile, spans, root, children)
                rec.update(base)
                cpu = attribute(profile, spans, 'cpu_us')
                rec['cpu_ms'] = cpu / 1000 if isinstance(cpu, (int, float)) else None
                rec['cache_hit'] = attribute(profile, spans, 'cache_hit')
                if args.with_text:
                    rec['text'] = text[:TEXT_LIMIT]
                for (name, owner) in rec['names']:
                    if owner < 0 and name not in profile.containers:
                        unmatched[name] += 1
                records.append(rec)
        print(f'{dataset}: {n_spans} spans, {len(by_trace)} traces, {units} units', file=sys.stderr)
    if not records:
        sys.exit('no units found: is --profile right for these spans?')
    runs = list(dict.fromkeys(name for name, _ in sources))
    write_bundle(args, profile, records, failures, unmatched, runs)


def write_bundle(args, profile, records, failures, unmatched, runs):
    out = args.output
    os.makedirs(os.path.join(out, 'data'), exist_ok=True)
    order = sorted(range(len(records)), key=lambda i: (records[i]['dataset'], records[i]['group'], natural(records[i]['label'])))
    records = [records[i] for i in order]

    names, name_index = [], {}

    def intern(name):
        if name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        return name_index[name]

    # Start times are kept relative to the earliest unit, in milliseconds, so they stay exact in JavaScript.
    epoch = min((r['start_ns'] for r in records), default=0)
    units = []
    name_rows = []
    for i, r in enumerate(records):
        units.append({
            'ds': r['dataset'], 'g': r['group'], 'l': r['label'], 'db': r['db'], 'fp': r['fp'], 't': r['trace'],
            'ms': round(r['total_ms'], 3), 'cpu': None if r['cpu_ms'] is None else round(r['cpu_ms'], 3),
            's': [float(f'{v:.4g}') for v in r['share']], 'p': [float(f'{v:.4g}') for v in r['part']],
            'c': r['counts'], 'f': r['frames'], 'k': i // CHUNK, 'at': round((r['start_ns'] - epoch) / 1e6, 3),
        })
        flat = []
        for (name, owner), (count, dur, own) in r['names'].items():
            flat += [intern(name), owner, count, dur // 1000, own // 1000]
        name_rows.append(flat)

    # Asynchronous spans, other than a compilation's root, go to a track per name, as Perfetto puts them, and within
    # it to lanes across all compilations: each takes the lowest lane free when it starts, so two share a lane only
    # when they do not overlap. Times are (run, microseconds), as runs are shown one after another. Tracks are
    # ordered by where in a compilation their spans usually start.
    run_index = {name: k for k, name in enumerate(runs)}
    flows, offsets = defaultdict(list), defaultdict(list)
    for i, r in enumerate(records):
        run, base = run_index[r['dataset']], (r['start_ns'] - epoch) // 1000
        for row, (name, parent, start, dur, flags) in enumerate(r['tree']):
            if parent >= 0 and flags & 1:
                flows[name].append(((run, base + start), (run, base + start + dur), i, row))
                offsets[name].append(start)
    lane_of, tracks = {}, []
    for name in sorted(flows, key=lambda n: (sorted(offsets[n])[len(offsets[n]) // 2], n)):
        busy, free, lanes = [], [], 0
        for start, end, i, row in sorted(flows[name]):
            while busy and busy[0][0] <= start:
                heapq.heappush(free, heapq.heappop(busy)[1])
            lane = heapq.heappop(free) if free else lanes
            lanes = max(lanes, lane + 1)
            heapq.heappush(busy, (end, lane))
            lane_of[(i, row)] = lane
        tracks.append({'name': name, 'lanes': lanes})
    print(f'{sum(len(f) for f in flows.values())} asynchronous spans in tracks ' + ', '.join(f"{t['name']} ({t['lanes']})" for t in tracks), file=sys.stderr)

    seen = [sum(r['seen'][k] for r in records) for k in range(len(profile.columns))]
    # The runs in the order given, each with when it started and its label.
    labels = dict(n.split('=', 1) for n in args.run_label)
    unknown = sorted(set(labels) - set(runs))
    if unknown:
        sys.exit(f"--run-label for no input: {', '.join(unknown)} (inputs: {', '.join(runs)})")
    run_rows = []
    for name in runs:
        mine = [u for u in units if u['ds'] == name]
        if mine:
            run_rows.append({'id': name, 'label': labels.get(name, ''), 'at': min(u['at'] for u in mine), 'units': len(mine)})
    meta = {
        'title': args.title or profile.raw.get('title', 'Violinoscope'),
        'profile': profile.raw['name'], 'generated': time.strftime('%Y-%m-%d %H:%M'),
        'units': PAGE_UNITS, 'chunk': CHUNK, 'epoch_ms': epoch // 1000000, 'jaeger': args.jaeger_link or (args.jaeger if args.jaeger else ''),
        'datasets': sorted(Counter(r['dataset'] for r in records).items()),
        'left': args.left.split(',') if args.left else [], 'right': args.right.split(',') if args.right else [],
        'with_text': bool(args.with_text),
        'names': dict(n.split('=', 1) for n in args.name),
        'scenarios': profile.raw.get('scenarios', []),
        'async_tracks': tracks,
        'runs': run_rows,
    }
    summary = {
        'meta': meta,
        'columns': [{'id': c['id'], 'label': c['label'], 'parent': c.get('parent'), 'seen': seen[k]}
                    for k, c in enumerate(profile.columns)],
        'partition': profile.partition, 'families': profile.raw.get('families', []),
        'counts': [{'id': c['id'], 'label': c['label'], 'per_call_of': c.get('per_call_of'), 'per_call_label': c.get('per_call_label')}
                   for c, _ in profile.counts],
        'units': units,
        'failures': [{'ds': f['dataset'], 'g': f['group'], 'l': f['label'], 't': f['trace'], 'reason': f['reason']} for f in failures],
    }
    write_js(os.path.join(out, 'data', 'summary.js'), 'EXPLORER_SUMMARY', summary)
    write_js(os.path.join(out, 'data', 'names.js'), 'EXPLORER_NAMES', {'names': names, 'rows': name_rows})
    for k in range(0, len(records), CHUNK):
        chunk_names, chunk_index = [], {}
        trees = []
        for i, r in enumerate(records[k:k + CHUNK], k):
            rows = []
            for row, (name, parent, start, dur, flags) in enumerate(r['tree']):
                if name not in chunk_index:
                    chunk_index[name] = len(chunk_names)
                    chunk_names.append(name)
                # Flags: bits 0-1 async and error, 2-9 the owning part plus one, 10 and up the asynchronous lane.
                rows += [chunk_index[name], parent, start, dur, flags | (lane_of.get((i, row), 0) << 10)]
            trees.append({'rows': rows, 'links': r.get('links', []), 'text': r.get('text', '')})
        with open(os.path.join(out, 'data', f'trees-{k // CHUNK:04d}.js'), 'w') as f:
            f.write(f'(window.EXPLORER_CHUNKS = window.EXPLORER_CHUNKS || {{}})[{k // CHUNK}]=')
            json.dump({'chunk': k // CHUNK, 'names': chunk_names, 'trees': trees}, f, separators=(',', ':'))
            f.write(';\n')

    web = os.path.join(HERE, 'web')
    for f in os.listdir(web):
        shutil.copy(os.path.join(web, f), os.path.join(out, f))

    print(f'{len(records)} units, {len(failures)} failed, {len(names)} span names -> {out}/index.html', file=sys.stderr)
    covered = [c['label'] for k, c in enumerate(profile.columns) if not seen[k]]
    if covered:
        print('not recorded in any unit (level too low, or renamed spans?): ' + ', '.join(covered), file=sys.stderr)
    if unmatched:
        top = ', '.join(f'{n} ({k})' for n, k in unmatched.most_common(8))
        print(f'span names under no part: {top}', file=sys.stderr)


def natural(s):
    return [int(p) if p.isdigit() else p for p in re.split(r'(\d+)', s or '')]


def write_js(path, name, value):
    with open(path, 'w') as f:
        f.write(f'window.{name}=')
        json.dump(value, f, separators=(',', ':'))
        f.write(';\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='*', help='[NAME=]file, directory or glob')
    ap.add_argument('-o', '--output', required=True, help='directory to write the explorer to')
    ap.add_argument('--profile', default=os.path.join(HERE, 'profiles', 'kqp_compile.json'))
    ap.add_argument('--title')
    ap.add_argument('--left', help='groups for the left half of each violin, comma-separated (default: the largest group)')
    ap.add_argument('--right', help='groups for the right half (default: the rest)')
    ap.add_argument('--group-by', choices=['label', 'database', 'dataset'], default='label',
                    help="what makes a group: the profile's label pattern in the query text (falling back to the dataset), "
                         'the database, or the input dataset')
    ap.add_argument('--skip-text', metavar='REGEX', help='leave out units whose query text matches, e.g. warm-up runs')
    ap.add_argument('--name', action='append', default=[], metavar='GROUP=LABEL', help='display name of a group or an input')
    ap.add_argument('--run-label', action='append', default=[], metavar='INPUT=LABEL',
                    help='a note on an input, such as the build it ran on, shown with its run')
    ap.add_argument('--with-text', action='store_true', help='keep query text for the drill-down (off by default: it may be sensitive)')
    ap.add_argument('--jaeger', help='Jaeger query service to fetch traces from, e.g. http://host:16686')
    ap.add_argument('--service', default='ydb')
    ap.add_argument('--operation', default='', help='Jaeger operation to search for (default: any)')
    ap.add_argument('--lookback', type=float, default=3600, help='seconds of history to fetch from Jaeger')
    ap.add_argument('--limit', type=int, default=2000)
    ap.add_argument('--jaeger-link', help='Jaeger UI base URL for trace links in the page')
    args = ap.parse_args()
    if not args.inputs and not args.jaeger:
        ap.error('give span files or --jaeger')
    build(args)


if __name__ == '__main__':
    main()
