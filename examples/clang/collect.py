#!/usr/bin/env python3
"""Compile fmt translation units at -O0 and -O2, retaining Clang time traces."""
import argparse
import os
from pathlib import Path
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path, help='fmt checkout (tested with 11.2.0)')
parser.add_argument('output', type=Path)
parser.add_argument('--compiler', default=os.environ.get('CXX','clang++'))
parser.add_argument('--flags', default='', help='Extra compiler flags, e.g. --sysroot=...')
parser.add_argument('--launcher', default='', help='Optional compiler launcher, e.g. balance')
parser.add_argument('--repeats', type=int, default=2)
parser.add_argument('--resume', action='store_true', help='Keep completed traces from an interrupted collection')
args = parser.parse_args()
source = args.source.resolve()
files = ['src/format.cc','src/os.cc'] + [f'test/{name}-test.cc' for name in
    ('args','base','chrono','color','compile','format','format-impl','ostream','printf','ranges','std','xchar')]
for repeat in range(args.repeats):
    for file in files:
        for opt in ('O0','O2'):
            folder = args.output / opt
            folder.mkdir(parents=True,exist_ok=True)
            target = (folder / f'{Path(file).stem}-{repeat}').resolve()
            if args.resume and Path(str(target)+'.json').exists():
                continue
            command = shlex.split(args.launcher) + [args.compiler,'-std=c++11',f'-{opt}',
                '-I'+str(source/'include'),'-I'+str(source/'test/gtest'),
                '-ftime-trace='+str(target)+'.json','-ftime-trace-granularity=100',
                *(['-DFMT_HEADER_ONLY'] if file == 'test/format-impl-test.cc' else []),
                *shlex.split(args.flags),'-c',str(source/file),'-o',str(target)+'.o']
            print(f'{opt} {file} ({repeat+1}/{args.repeats})',flush=True)
            subprocess.run(command,check=True)
