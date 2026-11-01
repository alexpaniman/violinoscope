"""Adapters for local profilers. Timestamps returned here are integer nanoseconds."""
from collections import defaultdict
from decimal import Decimal
import hashlib
import re
from pathlib import Path


def chrome_spans(document, source=''):
    """Chrome complete/duration events, including Clang -ftime-trace."""
    events = document if isinstance(document, list) else document['traceEvents']
    epoch = int(document.get('beginningOfTime', 0)) * 1000 if isinstance(document, dict) else 0
    trace = hashlib.sha256(source.encode()).hexdigest()[:32]
    threads, stacks = defaultdict(list), defaultdict(list)
    for event in events:
        key = (event.get('pid', 0), event.get('tid', 0))
        phase = event.get('ph')
        if phase == 'B':
            stacks[key].append(event)
            continue
        if phase == 'E':
            if not stacks[key]:
                raise ValueError('Chrome trace has an unmatched end event')
            begin = stacks[key].pop()
            event = {**begin, 'dur':Decimal(str(event['ts']))-Decimal(str(begin['ts']))}
        elif phase != 'X':
            continue
        # Clang also emits aggregate counters on artificial threads; these are not occurrences.
        if event.get('name', '').startswith('Total ') and 'count' in event.get('args', {}):
            continue
        a = epoch + int(Decimal(str(event['ts'])) * 1000)
        b = a + int(Decimal(str(event.get('dur', 0))) * 1000)
        if b < a:
            raise ValueError('Chrome trace has a negative duration')
        threads[key].append((a,b,event))
    if any(stacks.values()):
        raise ValueError('Chrome trace has an unfinished duration event')
    index = 0
    for events in threads.values():
        parents = []
        for a,b,event in sorted(events, key=lambda e:(e[0],-e[1])):
            while parents and (a >= parents[-1][1] or b > parents[-1][1]):
                parents.pop()
            index += 1
            ident = f'{index:016x}'
            detail = event.get('args', {}).get('detail')
            attrs = {'trace.format':'chrome'}
            if detail:
                attrs['job.name'] = str(detail)
            if not parents and source:
                attrs['job.name'] = Path(source).stem
            yield {'trace':trace, 'id':ident, 'parent':parents[-1][0] if parents else '',
                   'name':event.get('name', 'Unnamed'), 'start':a, 'end':b, 'attrs':attrs,
                   'error':False, 'message':'', 'links':[]}
            parents.append((ident,b))


def perf_spans(lines, source=''):
    """Read perf script -F comm,pid,tid,time,period,event,ip,sym,dso.

    Each thread is a sampled CPU-time unit. Periods, not wall-clock gaps, determine
    width. Only nanosecond cpu-clock/task-clock events are accepted.
    """
    header = re.compile(r'^\s*(.*?)\s+(\d+)(?:/|\s+)(\d+)\s+([\d.]+):\s+(\d+)\s+([^\s]+):\s*(.*)$')
    frame = re.compile(r'^\s*([0-9a-fA-F]+)\s+(.+?)\s+\((.*)\)\s*$')
    threads = defaultdict(list)
    current = None
    for number,line in enumerate(lines,1):
        match = header.match(line)
        if match:
            comm,pid,tid,time,period,event,tail = match.groups()
            if event.split(':')[0] not in ('cpu-clock','task-clock'):
                raise ValueError(f'{source}:{number}: perf needs cpu-clock or task-clock samples, not {event}')
            current = [int(Decimal(time)*10**9),int(period),[],comm]
            threads[pid,tid].append(current)
            if tail.strip():
                match = frame.match(tail)
                if match: current[2].append(match.group(2))
        elif line.strip() and not line.lstrip().startswith('#'):
            match = frame.match(line)
            if current is None or not match:
                raise ValueError(f'{source}:{number}: unrecognized perf script line')
            current[2].append(match.group(2))
    if not threads:
        raise ValueError('No perf samples found')
    for (pid,tid),samples in threads.items():
        trace = hashlib.sha256(f'{source}:{pid}:{tid}'.encode()).hexdigest()[:32]
        samples.sort(key=lambda s:s[0])
        spans, active, time = [], [], samples[0][0]
        attrs = {'trace.format':'perf', 'profile.kind':'sampled_cpu', 'job.name':f'{samples[0][3]} ({pid}/{tid})'}
        root = {'trace':trace,'id':'0000000000000001','parent':'','name':'Sampled CPU',
                'start':time,'end':time,'attrs':attrs,'error':False,'message':'','links':[]}
        for _,period,frames,_ in samples:
            # perf writes leaf first. Symbol offsets are samples of the same function.
            path = [re.sub(r'\+0x[0-9a-fA-F]+(?:/0x[0-9a-fA-F]+)?$', '', s) for s in reversed(frames)] or ['[unknown]']
            common = 0
            while common < min(len(active),len(path)) and active[common]['name'] == path[common]: common += 1
            active = active[:common]
            for name in path[common:]:
                span = {**root,'attrs':{},'id':f'{len(spans)+2:016x}', 'parent':active[-1]['id'] if active else root['id'],
                        'name':name,'start':time,'end':time}
                spans.append(span); active.append(span)
            time += period
            for span in active: span['end'] = time
        root['end'] = time
        yield root
        yield from spans
