#!/usr/bin/env python3
"""Writes made-up traces as OTLP JSON lines, one span per line, for tests and demos.

Each trace is one request: a root span with a few phases under it, rules repeated a varying number of times, an
asynchronous wait, a release that outlives the root, and now and then a failure. Durations are drawn from
log-normal distributions with a fixed seed, so the output is the same on every run.

  synth.py OUT.jsonl [--traces N] [--group NAME] [--seed S]
"""
import argparse
import json
import random

ROOT = 'Handle request'
RULES = ['Rule: Push filters', 'Rule: Merge projections', 'Rule: Pick join order']


class Trace:
    def __init__(self, rnd, index):
        self.rnd = rnd
        self.trace_id = f'{rnd.getrandbits(128):032x}'
        self.spans = []
        self.index = index

    def span(self, name, parent, start, end, attrs=None, error=None):
        span_id = f'{self.rnd.getrandbits(64):016x}'
        s = {'traceId': self.trace_id, 'spanId': span_id, 'parentSpanId': parent or '', 'name': name,
             'startTimeUnixNano': str(start), 'endTimeUnixNano': str(end),
             'attributes': [{'key': k, 'value': {'intValue': str(v)} if isinstance(v, int) else {'stringValue': v}}
                            for k, v in (attrs or {}).items()]}
        if error:
            s['status'] = {'code': 2, 'message': error}
        self.spans.append(s)
        return span_id


def ms(rnd, median, spread=0.5):
    """A duration in ns, log-normal around the median in ms."""
    return int(median * rnd.lognormvariate(0, spread) * 1e6)


def request(rnd, index, group, t0):
    t = Trace(rnd, index)
    root_start = t0
    at = root_start
    children = []

    def step(name, median, parent_kids, spread=0.5):
        nonlocal at
        start = at + ms(rnd, 0.02)
        end = start + ms(rnd, median, spread)
        parent_kids.append((name, start, end))
        at = end
        return start, end

    step('Read config', 0.3, children)
    step('Parse request', 1.5, children, 0.8)
    plan_start = at + ms(rnd, 0.02)
    at = plan_start
    plan_kids = []
    step('Resolve names', 0.6, plan_kids)
    for _ in range(rnd.randint(1, 12)):
        step(rnd.choice(RULES), 0.4, plan_kids, 1.0)
    plan_end = at + ms(rnd, 0.05)
    at = plan_end
    exec_start = at + ms(rnd, 0.02)
    at = exec_start
    exec_kids = []
    for k in range(rnd.randint(1, 4)):
        step(f'Run stage {k + 1}', 2.0, exec_kids, 0.9)
    exec_end = at + ms(rnd, 0.05)
    root_end = exec_end + ms(rnd, 0.1)

    failed = rnd.random() < 0.03
    text = f'-- {group} q{index % 7 + 1}, level 1\nSELECT {index};'
    root = t.span(ROOT, '', root_start, root_end, {'db.query.text': text, 'app.cpu_us': int((root_end - root_start) / 1500)},
                  error='Unknown table' if failed else None)
    for name, s, e in children:
        t.span(name, root, s, e)
    plan = t.span('Plan', root, plan_start, plan_end)
    for name, s, e in plan_kids:
        rule = t.span(name, plan, s, e)
        if name.startswith('Rule: ') and rnd.random() < 0.4:
            t.span('Compute statistics', rule, s + (e - s) // 4, s + (e - s) // 2)
    run = t.span('Execute', root, exec_start, exec_end)
    for name, s, e in exec_kids:
        t.span(name, run, s, e)
    # Waits beside the planning, on their own track; the release runs on after the request is answered.
    wait_start = plan_start + ms(rnd, 0.1)
    t.span('Wait for metadata', root, wait_start, wait_start + ms(rnd, 1.0, 1.2), {'ydb.flow': 'async'})
    t.span('Release state', root, root_end - ms(rnd, 0.05), root_end + ms(rnd, 0.2), {'ydb.flow': 'async'})
    return t, root_end


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('output')
    ap.add_argument('--traces', type=int, default=300)
    ap.add_argument('--group', default='synthetic')
    ap.add_argument('--seed', type=int, default=1)
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    at = 1_700_000_000_000_000_000
    with open(args.output, 'w') as f:
        for i in range(args.traces):
            t, end = request(rnd, i, args.group, at)
            at = end + ms(rnd, 5.0)
            for s in t.spans:
                f.write(json.dumps(s, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
