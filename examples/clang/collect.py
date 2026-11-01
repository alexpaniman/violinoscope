#!/usr/bin/env python3
"""Record a full Clang build, its unit-test builds and its regression compilations."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path, help='llvm-project checkout')
    p.add_argument('build', type=Path, help='a new Ninja build directory')
    p.add_argument('output', type=Path)
    p.add_argument('--stage', choices=('all', 'build', 'tests'), default='all')
    p.add_argument('--cc', default='clang')
    p.add_argument('--cxx', default='clang++')
    p.add_argument('--cmake', default='cmake')
    p.add_argument('--cmake-arg', action='append', default=[], help='extra setting, e.g. --cmake-arg=-DCMAKE_SYSROOT=/path')
    p.add_argument('--launcher', default='', help='e.g. "balance-exec --kind compile --"')
    p.add_argument('--link-launcher', default='', help='e.g. "balance-exec --kind link --"')
    p.add_argument('--frequency', type=int, default=0, help='also record perf CPU samples at this frequency; 0 disables perf')
    p.add_argument('--granularity', type=int, default=1000, help='minimum time-trace event duration in microseconds')
    a = p.parse_args()
    if a.frequency < 0 or a.granularity < 0:
        p.error('frequency and granularity must be nonnegative')
    source, build, out = a.source.resolve(), a.build.resolve(), a.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    record = out / 'record.py'
    shutil.copy2(Path(__file__).with_name('record.py'), record)
    common = {'output':str(out), 'frequency':a.frequency, 'granularity':a.granularity}
    build_config = out / 'build.json'
    build_config.write_text(json.dumps({**common, 'group':'Build', 'unit_test_group':'Unit tests'}, indent=2)+'\n')
    def run(command, **kw):
        print(shlex.join(map(str, command)), flush=True)
        return subprocess.run(command, **kw)
    if a.stage in ('all', 'build'):
        launcher = [*shlex.split(a.launcher), sys.executable, str(record), str(build_config), '--']
        configure = [a.cmake, '-G', 'Ninja', '-S', str(source/'llvm'), '-B', str(build),
                     '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
                     '-DLLVM_ENABLE_PROJECTS=clang', '-DLLVM_INCLUDE_BENCHMARKS=OFF',
                     '-DCMAKE_C_COMPILER='+a.cc, '-DCMAKE_CXX_COMPILER='+a.cxx,
                     '-DCMAKE_C_COMPILER_LAUNCHER='+';'.join(launcher),
                     '-DCMAKE_CXX_COMPILER_LAUNCHER='+';'.join(launcher)]
        if a.link_launcher:
            for lang in ('C', 'CXX'):
                configure.append(f'-DCMAKE_{lang}_LINKER_LAUNCHER='+';'.join(shlex.split(a.link_launcher)))
        run([*configure, *a.cmake_arg], check=True)
        provenance = {'source':str(source), 'configure':configure+a.cmake_arg,
                      'revision':subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'], text=True).strip(),
                      'compiler':subprocess.check_output([a.cxx,'--version'], text=True).strip()}
        (out/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
        run([a.cmake, '--build', str(build), '--target', 'clang', 'clang-test-depends'], check=True)
    if a.stage in ('all', 'tests'):
        test_config = out/'tests.json'
        test_config.write_text(json.dumps({**common, 'group':'Regression tests',
                                          # These mangling stress tests expand enormous type names in time-trace details.
                                          'skip_time_trace':['*/mangle-ms-back-references-pr13207.cpp', '*/pr29160.cpp'],
                                          'compiler':str(build/'bin/clang')}, indent=2)+'\n')
        wrapper = out/'clang-record'
        # Keep the outer wrapper transparent to lit's signal/crash checks.
        wrapper.write_text('#!/bin/sh\nexec '+shlex.join([sys.executable, str(record), str(test_config), '--'])+' "$@"\n')
        wrapper.chmod(0o755)
        env = {**os.environ, 'CLANG':str(wrapper)}
        result = run([sys.executable, str(build/'bin/llvm-lit'), '-sv',
                      '-o', str(out/'lit-results.json'), str(build/'tools/clang/test')], env=env)
        print(f'Regression suite exit code: {result.returncode}; results: {out / "lit-results.json"}', flush=True)
        return result.returncode
    return 0


if __name__ == '__main__':
    sys.exit(main())
