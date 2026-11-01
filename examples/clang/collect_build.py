#!/usr/bin/env python3
"""Replay selected compilation-database entries, one measurement per source file."""
import argparse
import fnmatch
import gzip
import hashlib
import json
from pathlib import Path
import shlex
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('database', type=Path)
    p.add_argument('output', type=Path)
    p.add_argument('--group', action='append', required=True, metavar='NAME=GLOB')
    p.add_argument('--limit', type=int, default=32, help='evenly spaced files per group; 0 means all')
    p.add_argument('--perf', action='store_true', help='also collect cpu-clock stacks (requires Linux perf permission)')
    p.add_argument('--frequency', type=int, default=199)
    p.add_argument('--granularity', type=int, default=100, help='time-trace minimum duration in microseconds')
    p.add_argument('--launcher', default='', help='e.g. "balance-exec --kind compile --"')
    p.add_argument('--resume', action='store_true')
    a = p.parse_args()
    if a.limit < 0 or a.frequency <= 0 or a.granularity < 0:
        p.error('limit/granularity must be nonnegative; frequency must be positive')
    a.output = a.output.resolve()
    entries = json.loads(a.database.read_text())
    manifest = []
    for group in a.group:
        name, pattern = group.split('=', 1)
        if not name or Path(name).name != name or name in ('.', '..'):
            p.error('group names must be single directory names')
        selected = {e['file']: e for e in entries if fnmatch.fnmatch(e['file'], pattern) or fnmatch.fnmatch(e['file'], '*/'+pattern)}
        selected = [selected[k] for k in sorted(selected)]
        if not selected:
            p.error(f'no compilation commands match {pattern}')
        if a.limit and len(selected) > a.limit:
            selected = [selected[k*(len(selected)-1)//max(1,a.limit-1)] for k in range(a.limit)]
        for e in selected:
            source = Path(e['file'])
            if not source.is_absolute():
                source = Path(e['directory'])/source
            label = source.name
            if sum(Path(item['file']).name == label for item in selected) > 1:
                label += '-'+hashlib.sha256(str(source).encode()).hexdigest()[:6]
            folder = a.output/name
            folder.mkdir(parents=True, exist_ok=True)
            base = folder/label
            trace, profile = Path(str(base)+'.json'), Path(str(base)+'.perf.txt.gz')
            original = e.get('arguments') or shlex.split(e['command'])
            command, skip = [], False
            for token in original:
                if skip:
                    skip = False
                    continue
                if token in ('-o', '-MF', '-MT', '-MQ'):
                    skip = True
                elif token not in ('-MD', '-MMD') and not token.startswith('-ftime-trace'):
                    command.append(token)
            command += ['-o', str(base)+'.o', f'-ftime-trace={trace}', f'-ftime-trace-granularity={a.granularity}']
            record = {'source':str(source), 'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                      'directory':e['directory'], 'command':command, 'perf_hz':a.frequency if a.perf else None,
                      'compiler':subprocess.check_output([command[0], '--version'], text=True).splitlines()[0]}
            (folder/'metadata').mkdir(exist_ok=True)
            stamp = folder/'metadata'/(label+'.json')
            if a.resume and stamp.exists():
                previous = json.loads(stamp.read_text())
                empty = previous.pop('perf_empty', False)
                if previous == record and trace.exists() and (not a.perf or profile.exists() or empty):
                    if empty:
                        record['perf_empty'] = True
                    manifest.append(record)
                    continue
            stamp.unlink(missing_ok=True)
            print(f'{name}: {source.name}', flush=True)
            measured = command
            if a.perf:
                measured = ['perf', 'record', '-q', '-e', 'cpu-clock:u', '-F', str(a.frequency),
                            '--call-graph', 'dwarf,16384', '-o', str(base)+'.perf.data', '--', *command]
            with Path(str(base)+'.log').open('w') as log:
                subprocess.run([*shlex.split(a.launcher), *measured], cwd=e['directory'], stdout=log, stderr=log, check=True)
                if a.perf:
                    with gzip.open(profile, 'wb') as out:
                        proc = subprocess.Popen(['perf', 'script', '--no-inline', '-i', str(base)+'.perf.data',
                                                 '-F', 'comm,pid,tid,time,period,event,ip,sym,dso'], stdout=subprocess.PIPE, stderr=log)
                        while block := proc.stdout.read(1024*1024):
                            out.write(block)
                        if proc.wait():
                            raise RuntimeError(f'perf export failed; see {base}.log')
                    Path(str(base)+'.perf.data').unlink()
                    with gzip.open(profile, 'rb') as out:
                        empty = not out.read(1)
                    if empty:
                        profile.replace(folder/'metadata'/profile.name)
                        record['perf_empty'] = True
                        print(f'  No CPU samples: {source.name}; time trace retained', flush=True)
            Path(str(base)+'.o').unlink()
            stamp.write_text(json.dumps(record, indent=2)+'\n')
            manifest.append(record)
    (a.output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(f'{len(manifest)} compilations in {a.output}', flush=True)


if __name__ == '__main__':
    main()
