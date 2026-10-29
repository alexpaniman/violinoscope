#!/usr/bin/env python3
"""Turn OpenTelemetry or Jaeger spans into a self-contained interactive HTML report.

  python3 violinoscope.py before.jsonl after.jsonl --unit "Handle request" -o report.html
  python3 violinoscope.py baseline=old.json candidate=new.json --layout layout.json

Inputs may be files, directories, globs, or NAME=PATH. Without --unit, trace roots
are the units of work. Dataset names come from resources or input filenames.
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
import sys
import time
import tempfile
from pathlib import Path

import layouts
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
PAGE_UNITS = 500       # the page's time frames are on a 1/PAGE_UNITS grid of each unit's span
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


def from_otlp_span(s, relation_attr="span.link.relation"):
    status = s.get('status') or {}
    return {
        'trace': b64_or_hex(s.get('traceId', '')), 'id': b64_or_hex(s.get('spanId', '')),
        'parent': b64_or_hex(s.get('parentSpanId', '')), 'name': s.get('name', ''),
        'start': int(s.get('startTimeUnixNano', 0)), 'end': int(s.get('endTimeUnixNano', 0)),
        'attrs': {a['key']: otlp_value(a.get('value', {})) for a in s.get('attributes', [])},
        'error': status.get('code') in OTLP_STATUS_ERROR, 'message': status.get('message', ''),
        # Links to other spans, with what each means: depends_on, follows_from, or nothing said.
        'links': [(b64_or_hex(l.get('spanId', '')), next((otlp_value(a.get('value', {})) for a in l.get('attributes', [])
                                                          if a.get('key') == relation_attr), ''))
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
            'dataset': tags.get('dataset.name') or trace.get('processes', {}).get(s.get('processID'), {}).get('serviceName'),
            'links': [(r['spanID'].lower(), 'follows_from') for r in s.get('references', []) if r.get('refType') == 'FOLLOWS_FROM'],
        }


def spans_from_document(doc, relation_attr="span.link.relation"):
    if isinstance(doc, dict) and 'batches' in doc:  # Tempo's trace-by-ID JSON
        doc = {'resourceSpans': doc['batches']}
    if isinstance(doc, dict) and isinstance(doc.get('trace'), dict):
        yield from spans_from_document(doc['trace'], relation_attr)
        return
    if isinstance(doc, dict) and 'resourceSpans' in doc:
        for rs in doc['resourceSpans']:
            resource = {a['key']: otlp_value(a.get('value', {})) for a in rs.get('resource', {}).get('attributes', [])}
            for ss in rs.get('scopeSpans', rs.get('instrumentationLibrarySpans', [])):
                for s in ss.get('spans', []):
                    span = from_otlp_span(s, relation_attr)
                    span["dataset"] = resource.get("dataset.name") or resource.get("service.name")
                    yield span
    elif isinstance(doc, dict) and 'data' in doc and isinstance(doc['data'], list):
        for trace in doc['data']:
            yield from from_jaeger_trace(trace)
    elif isinstance(doc, dict) and 'spanId' in doc:
        yield from_otlp_span(doc, relation_attr)
    elif isinstance(doc, list):
        for item in doc:
            yield from spans_from_document(item, relation_attr)


def read_file(path, relation_attr="span.link.relation"):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as f:
        head = f.readline()
        while head and not head.strip():
            head = f.readline()
        f.seek(0)
        lines = bool(head.strip()) and _first_line_parses(head)
        if lines:
            for number, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    doc = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path}:{number}: invalid JSON: {error.msg}") from error
                yield from spans_from_document(doc, relation_attr)
        else:
            yield from spans_from_document(json.load(f), relation_attr)


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
# One unit of work: its root span and everything under it, in tree order.

def analyze_unit(root, children, flow_attr="span.flow"):
    lo, hi = root['start'], root['end']
    inside, stack = [], [(root, -1)]
    seen = set()
    while stack:
        s, parent_row = stack.pop()
        if s["id"] in seen:
            raise ValueError(f"Cyclic span tree in trace {root['trace']}")
        seen.add(s["id"])
        inside.append((s, parent_row))
        row = len(inside) - 1
        for k in sorted(children[s['id']], key=lambda x: x['start'], reverse=True):
            stack.append((k, row))
    # Rows: name, parent row, start and length in microseconds from the unit's start, and flags: 1 asynchronous
    # (a new logical flow; unmarked descendants inherit it), 2 failed.
    tree = [(s['name'], parent_row, (s['start'] - lo) // 1000, (s['end'] - s['start']) // 1000,
             (1 if s['attrs'].get(flow_attr) == 'async' else 0) | (2 if s['error'] else 0))
            for s, parent_row in inside]
    # Links between its spans, as rows: from, to, and 1 for depends_on, 2 for follows_from, 0 else.
    row_of = {s['id']: row for row, (s, _) in enumerate(inside)}
    links = [x for row, (s, _) in enumerate(inside) for to, rel in s.get('links', []) if to in row_of
             for x in (row, row_of[to], {'depends_on': 1, 'follows_from': 2}.get(rel, 0))]
    return {'total_ms': (hi - lo) / 1e6, 'start_ns': lo, 'tree': tree, 'links': links, 'spans': [s for s, _ in inside]}


def first_attr(spans, key):
    for s in spans:
        if key in s['attrs']:
            return s['attrs'][key]
    return None


def failure_detail(spans, root):
    """The deepest failed span's message: what went wrong, rather than that the unit failed."""
    failed = [s for s in spans if s['error'] and s['message']]
    return failed[-1]['message'] if failed else root['message']


# ---------------------------------------------------------------------------------------------------------------

def build(args):
    label_regex = re.compile(args.label_regex) if args.label_regex else None
    sources = []
    for item in args.inputs:
        name, _, pattern = item.rpartition('=') if '=' in item and not os.path.exists(item) else ('', '', item)
        paths = sorted(glob.glob(pattern)) or [pattern]
        expanded = []
        for p in paths:
            expanded += sorted(os.path.join(p, f) for f in os.listdir(p)) if os.path.isdir(p) else [p]
        sources.append((name or os.path.splitext(os.path.basename(pattern.rstrip('/')))[0], expanded, bool(name)))
    if args.jaeger:
        sources.append(('jaeger', None, False))

    records, failures = [], []
    unit_names = Counter()
    seen_units = set()
    for fallback, paths, explicit in sources:
        by_trace = defaultdict(dict)
        stream = (fetch_jaeger(args.jaeger, args.service, args.operation, args.lookback, args.limit) if paths is None
                  else (s for p in paths for s in read_file(p, args.link_relation_attr)))
        n_spans = 0
        for s in stream:
            if s['end'] < s['start']:
                raise ValueError(f"Span {s['id']} ends before it starts")
            by_trace[s['trace']][s['id']] = s
            n_spans += 1
        units = 0
        for trace_id, spans_by_id in by_trace.items():
            spans = list(spans_by_id.values())
            children = defaultdict(list)
            for s in spans:
                children[s['parent']].append(s)
            text = first_attr(spans, args.text_attr) if args.text_attr else None
            text = text if isinstance(text, str) else ''
            group, label = None, None
            if label_regex and text:
                m = label_regex.search(text)
                if m:
                    group, label = m.groupdict().get('group'), m.groupdict().get('label')
            if args.skip_text and re.search(args.skip_text, text or ''):
                continue
            if args.group_by.startswith('attr:'):
                value = first_attr(spans, args.group_by[5:])
                group = str(value) if value is not None else None
            elif args.group_by == 'dataset':
                group = None
            fp = fingerprint(text) if text else ''
            roots = ([s for s in spans if s['name'] == args.unit] if args.unit
                     else [s for s in spans if not s['parent'] or s['parent'] not in spans_by_id])
            for root in roots:
                dataset = fallback if explicit else root.get('dataset') or fallback
                key = (dataset, trace_id, root['id'])
                if key in seen_units:
                    continue
                seen_units.add(key)
                units += 1
                unit_names[root['name']] += 1
                base = {'dataset': dataset, 'group': group or dataset, 'label': label or (fp[:8] or root['id'][:8]),
                        'trace': trace_id, 'fp': fp}
                rec = analyze_unit(root, children, args.flow_attr)
                if root['error']:
                    failures.append(dict(base, reason=failure_reason(failure_detail(rec['spans'], root))))
                    continue
                del rec['spans']
                rec.update(base)
                cpu = root['attrs'].get(args.cpu_attr) if args.cpu_attr else None
                rec['cpu_ms'] = cpu / 1000 if isinstance(cpu, (int, float)) else None
                if args.with_text:
                    rec['text'] = text[:TEXT_LIMIT]
                records.append(rec)
        print(f'{fallback}: {n_spans} spans, {len(by_trace)} traces, {units} units', file=sys.stderr)
    if not records:
        sys.exit(f'no units found: no span is named {args.unit!r}' if args.unit else 'no units found')
    root_names = {r['tree'][0][0] for r in records}
    if not args.unit and len(root_names) > 1:
        raise ValueError('Multiple root span names; choose --unit: ' + ', '.join(sorted(root_names)))
    runs = list(dict.fromkeys(r['dataset'] for r in records + failures))
    unit = args.unit or unit_names.most_common(1)[0][0]
    write_bundle(args, unit, records, failures, runs)


def write_bundle(args, unit, records, failures, runs):
    out = args.output
    os.makedirs(os.path.join(out, 'data'), exist_ok=True)
    order = sorted(range(len(records)), key=lambda i: (records[i]['dataset'], records[i]['group'], natural(records[i]['label'])))
    records = [records[i] for i in order]

    # Start times are kept relative to the earliest unit, in milliseconds, so they stay exact in JavaScript.
    epoch = min((r['start_ns'] for r in records), default=0)
    units = []
    for i, r in enumerate(records):
        units.append({
            'ds': r['dataset'], 'g': r['group'], 'l': r['label'], 'fp': r['fp'], 't': r['trace'],
            'ms': round(r['total_ms'], 3), 'cpu': None if r['cpu_ms'] is None else round(r['cpu_ms'], 3),
            'k': i // CHUNK, 'at': round((r['start_ns'] - epoch) / 1e6, 3),
        })

    # Asynchronous spans, other than a unit's root, go to a track per name, as Perfetto puts them, and within it to
    # lanes across all units: each takes the lowest lane free when it starts, so two share a lane only when they do
    # not overlap. Times are (run, microseconds), as runs are shown one after another. Tracks are ordered by where in
    # a unit their spans usually start.
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
    if tracks:
        print(f'{sum(len(f) for f in flows.values())} asynchronous spans in tracks ' + ', '.join(f"{t['name']} ({t['lanes']})" for t in tracks), file=sys.stderr)

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
        'title': args.title or unit, 'unit': unit, 'generated': time.strftime('%Y-%m-%d %H:%M'),
        'units': PAGE_UNITS, 'chunk': CHUNK, 'epoch_ms': epoch // 1000000, 'jaeger': args.jaeger_link or (args.jaeger if args.jaeger else ''),
        'datasets': sorted(Counter(r['dataset'] for r in records).items()),
        'left': args.left.split(',') if args.left else [], 'right': args.right.split(',') if args.right else [],
        'with_text': bool(args.with_text),
        'names': dict(n.split('=', 1) for n in args.name),
        'async_tracks': tracks,
        'runs': run_rows,
    }
    summary = {
        'meta': meta,
        'units': units,
        'failures': [{'ds': f['dataset'], 'g': f['group'], 'l': f['label'], 't': f['trace'], 'reason': f['reason']} for f in failures],
    }
    write_js(os.path.join(out, 'data', 'summary.js'), 'EXPLORER_SUMMARY', summary)
    if args.layout:
        doc = layouts.decode(json.loads(Path(args.layout).read_text()))
        if doc['unit'] != unit:
            raise ValueError(f"Layout is for {doc['unit']!r}, not {unit!r}")
        doc['saved'] = hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()
        write_js(os.path.join(out, 'data', 'layout.js'), 'EXPLORER_LAYOUT', doc)
    elif not os.path.exists(os.path.join(out, 'data', 'layout.js')):
        write_js(os.path.join(out, 'data', 'layout.js'), 'EXPLORER_LAYOUT', None)
    for k in range(0, len(records), CHUNK):
        chunk_names, chunk_index = [], {}
        trees = []
        for i, r in enumerate(records[k:k + CHUNK], k):
            rows = []
            for row, (name, parent, start, dur, flags) in enumerate(r['tree']):
                if name not in chunk_index:
                    chunk_index[name] = len(chunk_names)
                    chunk_names.append(name)
                # Flags: bits 0-1 async and error, 10 and up the asynchronous lane.
                rows += [chunk_index[name], parent, start, dur, flags | (lane_of.get((i, row), 0) << 10)]
            trees.append({'rows': rows, 'links': r.get('links', []), 'text': r.get('text', '')})
        with open(os.path.join(out, 'data', f'trees-{k // CHUNK:04d}.js'), 'w') as f:
            f.write(f'(window.EXPLORER_CHUNKS = window.EXPLORER_CHUNKS || {{}})[{k // CHUNK}]=')
            json.dump({'chunk': k // CHUNK, 'names': chunk_names, 'trees': trees}, f, separators=(',', ':'))
            f.write(';\n')

    write_page(out, split_data=args.split_data, output=getattr(args, 'html_output', None))
    print(f"{len(records)} units of {unit}, {len(failures)} failed -> {getattr(args, 'html_output', None) or out + '/index.html'}", file=sys.stderr)


def write_page(out, split_data=False, output=None):
    """Inline code, styles and (by default) every data chunk. No network required."""
    web = Path(HERE) / 'web'
    page = (web / 'index.html').read_text()
    data = Path(out) / 'data'

    def script(code, marker=''):
        code = re.sub(r'</(script)', r'<\\/\1', code, flags=re.I)
        return f'<script{marker}>\n{code}</script>'

    def inline(match):
        src = match[1]
        if src.startswith('data/'):
            return match[0] if split_data else script((Path(out) / src).read_text())
        return script((web / src).read_text(), f' data-v="{src[:-3]}"')

    css = (web / 'app.css').read_text()
    page = page.replace('<link rel="stylesheet" href="app.css">', f'<style data-v>\n{css}</style>')
    if not split_data:
        summary = json.loads((data / 'summary.js').read_text().split('=', 1)[1].rstrip().rstrip(';'))
        count = max((u['k'] for u in summary['units']), default=-1) + 1
        chunks = '\n'.join(script((data / f'trees-{k:04d}.js').read_text()) for k in range(count))
        page = page.replace('<script src="core.js"></script>', chunks + '\n<script src="core.js"></script>')
    page = re.sub(r'<script src="([^"]+)"></script>', inline, page)
    target = Path(output) if output else Path(out) / 'index.html'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(page)


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
    ap.add_argument('-o', '--output', default='violinoscope.html', help='HTML file (default: violinoscope.html), or a directory')
    ap.add_argument('--layout', help='Saved layout JSON to use as the report’s default')
    ap.add_argument('--split-data', action='store_true', help='Keep data in separate files (requires directory output)')
    ap.add_argument('--flow-attr', default='span.flow', help='Attribute marking a logical flow boundary with value async')
    ap.add_argument('--link-relation-attr', default='span.link.relation', help='Link attribute naming depends_on or follows_from')
    ap.add_argument('--unit', help="the span that is one unit of work (default: each trace's root)")
    ap.add_argument('--title', help='the page title (default: the unit span\'s name)')
    ap.add_argument('--left', help='groups for the left half of each violin, comma-separated (default: the largest group)')
    ap.add_argument('--right', help='groups for the right half (default: the rest)')
    ap.add_argument('--group-by', default='label', metavar='label|dataset|attr:KEY',
                    help='what makes a group: the group in --label-regex (falling back to the input), the input, '
                         'or the value of an attribute on any span of the trace')
    ap.add_argument('--text-attr', default='db.query.text', metavar='KEY',
                    help='the attribute holding query text, for --label-regex, --skip-text, --with-text and fingerprints')
    ap.add_argument('--label-regex', metavar='REGEX', help='named groups "group" and "label" read from the query text')
    ap.add_argument('--cpu-attr', metavar='KEY', help="an attribute of the unit's span with its CPU time in microseconds")
    ap.add_argument('--skip-text', metavar='REGEX', help='leave out units whose query text matches, e.g. warm-up runs')
    ap.add_argument('--name', action='append', default=[], metavar='GROUP=LABEL', help='display name of a group or an input')
    ap.add_argument('--run-label', action='append', default=[], metavar='INPUT=LABEL',
                    help='a note on an input, such as the build it ran on, shown with its run')
    ap.add_argument('--with-text', action='store_true', help='keep query text for the drill-down (off by default: it may be sensitive)')
    ap.add_argument('--jaeger', help='Jaeger query service to fetch traces from, e.g. http://host:16686')
    ap.add_argument('--service', help='Service name to search for with --jaeger')
    ap.add_argument('--operation', default='', help='Jaeger operation to search for (default: any)')
    ap.add_argument('--lookback', type=float, default=3600, help='seconds of history to fetch from Jaeger')
    ap.add_argument('--limit', type=int, default=2000)
    ap.add_argument('--jaeger-link', help='Jaeger UI base URL for trace links in the page')
    args = ap.parse_args()
    if not args.inputs and not args.jaeger:
        ap.error('give span files or --jaeger')
    if args.group_by not in ('label', 'dataset') and not args.group_by.startswith('attr:'):
        ap.error('--group-by is label, dataset or attr:KEY')
    if args.jaeger and not args.service:
        ap.error('--jaeger requires --service')
    try:
        if args.output.lower().endswith(('.html', '.htm')):
            if args.split_data:
                ap.error('--split-data requires directory output')
            args.html_output = args.output
            with tempfile.TemporaryDirectory(prefix='violinoscope-') as folder:
                args.output = folder
                build(args)
        else:
            build(args)
    except (ValueError, OSError, KeyError, TypeError) as error:
        ap.exit(1, f'error: {error}\n')


if __name__ == '__main__':
    main()
