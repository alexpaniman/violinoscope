#!/usr/bin/env python3
"""Compiler launcher for time traces and optional CPU sampling."""
import gzip
import fnmatch
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import uuid


def arguments(command, seen=None):
    """Inspect response files for inputs; pass the original command to Clang."""
    seen = set() if seen is None else seen
    for arg in command:
        path = Path(arg[1:]) if arg.startswith('@') else None
        if path and path.is_file() and path.resolve() not in seen:
            seen.add(path.resolve())
            yield from arguments(shlex.split(path.read_text()), seen)
        else:
            yield arg


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    command = sys.argv[2:]
    if command[:1] == ['--']:
        command = command[1:]
    if config.get('compiler'):
        command.insert(0, config['compiler'])
    if not command:
        raise SystemExit('expected a compiler command after the configuration file')
    args = list(arguments(command[1:]))
    sources = [s for s in args if not s.startswith('-') and
               Path(s).suffix.lower() in ('.c', '.cc', '.cpp', '.cxx', '.m', '.mm', '.cu', '.cl',
                                         '.h', '.hpp', '.ll', '.bc', '.s', '.i', '.ii', '.cppm')]
    # Informational driver commands must keep their output byte-for-byte intact.
    frontend = '-cc1' in args or '-x' in args
    if (not sources and '-' not in args and not frontend) or any(s in args for s in ('-###', '--version', '-version', '--help', '-help')):
        os.execvp(command[0], command)
    source = sources[-1] if sources else next((s for s in reversed(args) if not s.startswith('-') and Path(s).is_file()), 'stdin.c')
    group = config.get('group', 'Build')
    if config.get('unit_test_group') and '/unittests/' in str(Path(source).absolute()):
        group = config['unit_test_group']
    root = Path(config['output']).resolve()
    ident = f'{time.time_ns()}-{uuid.uuid4().hex[:8]}'
    label = re.sub(r'[^\w.+-]', '_', Path(source).name)
    folder = root / group / ident
    folder.mkdir(parents=True)
    trace = folder / (label + '.json')
    measured = list(command)
    trace_enabled = config.get('time_trace', True) and not any(fnmatch.fnmatch(source, pattern) for pattern in config.get('skip_time_trace', []))
    if trace_enabled and '-cc1as' not in args and not any(s.startswith('-ftime-trace') for s in args):
        flags = [f'-ftime-trace={trace}', f'-ftime-trace-granularity={config.get("granularity", 1000)}']
        # The driver ignores -ftime-trace with -fsyntax-only/-E. Pass those
        # options to the frontend explicitly, without suppressing diagnostics.
        if '-cc1' not in args and any(s in args for s in ('-fsyntax-only', '-E', '--driver-mode=cl')):
            flags = [item for flag in flags for item in ('-Xclang', flag)]
        at = measured.index('--') if '--' in measured else len(measured)
        measured[at:at] = flags
    frequency = config.get('frequency', 0)
    data = folder / 'cpu.data'
    if frequency:
        measured = ['perf', 'record', '-q', '-e', 'cpu-clock:u', '-F', str(frequency),
                    '--call-graph', 'dwarf,16384', '-o', str(data), '--', *measured]
    started = time.time_ns()
    code = subprocess.call(measured)
    record = {'source':str(Path(source).absolute()), 'directory':os.getcwd(),
              'command':command, 'returncode':code, 'started_ns':started,
              'elapsed_ns':time.time_ns()-started, 'trace':trace.exists(), 'perf_hz':frequency}
    if frequency and data.exists():
        profile = folder / (label + '.perf.txt.gz')
        with gzip.open(profile, 'wb') as out, (folder / 'perf.log').open('w') as log:
            proc = subprocess.Popen(['perf', 'script', '--no-inline', '-i', str(data),
                                     '-F', 'comm,pid,tid,time,period,event,ip,sym,dso'],
                                    stdout=subprocess.PIPE, stderr=log)
            size = 0
            while block := proc.stdout.read(1024*1024):
                size += len(block)
                out.write(block)
            record['perf_export_returncode'] = proc.wait()
            record['perf_bytes'] = size
        if record['perf_export_returncode'] == 0:
            data.unlink()
        if not size:
            profile.unlink()
    metadata = root / 'metadata' / group
    metadata.mkdir(parents=True, exist_ok=True)
    (metadata / (ident + '.json')).write_text(json.dumps(record, separators=(',', ':'))+'\n')
    # Preserve crashes for lit's `not --crash` assertions.
    if code < 0:
        signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code


if __name__ == '__main__':
    sys.exit(main())
