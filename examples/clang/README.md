# Clang build and tests

Each time-trace dot is a compiler invocation; each CPU dot is one sampled compiler thread. The example records the full Clang build and its test dependencies, compilation of the unit-test binaries, and compiler invocations made by the Clang regression suite. Groups remain separate so you can compare their different workloads.

Requires Clang, CMake, Ninja, Git, Python and the usual C/C++ development headers and libraries. Linux perf is optional. Use a fresh build directory to capture every compilation; an incremental build records only commands that actually run.

```sh
git clone --depth 1 --branch llvmorg-20.1.8 https://github.com/llvm/llvm-project.git /tmp/llvm-project
python3 examples/clang/collect.py /tmp/llvm-project /tmp/clang-build /tmp/clang-traces --frequency 49
```

Omit `--frequency` for time traces alone. All default LLVM backends are built. `--stage build` or `--stage tests` runs just that stage; rerunning the build resumes through Ninja. `--cmake-arg=-DNAME=VALUE` adds a CMake setting. For resource control with clang-balancer, add `--launcher 'balance-exec --kind compile --' --link-launcher 'balance-exec --kind link --'`.

```sh
python3 violinoscope.py \
  'Build=/tmp/clang-traces/Build/*/*.json' \
  'Unit tests=/tmp/clang-traces/Unit tests/*/*.json' \
  'Regression tests=/tmp/clang-traces/Regression tests/*/*.json' \
  --unit ExecuteCompiler --timeline unit --left Build --right 'Unit tests' \
  --layout examples/clang/phases.layout.json --title 'Clang build and tests' -o clang.html
```

For the CPU report, replace `*.json` with `*.perf.txt.gz`, the unit with `Sampled CPU`, the layout with `examples/clang/cpu.layout.json`, and the output with `clang-cpu.html`.

The phase layout extracts templates, expands parsing, call-graph optimization and code generation, shows Rest rows, hides the intermediate Backend, and includes independent front-end and back-end projections. The CPU layout also extracts repeated optimizer passes. Main-tree shares subtract; projections overlap freely. The initial comparison is Build versus Unit tests; use the legend to enable Regression tests.

Time traces retain events lasting at least 1 ms; `--granularity` changes that cutoff. CPU samples measure time on CPU, not elapsed time or waits. Very short invocations can have no samples. Diagnostic-only commands and existing time-trace tests may produce no additional time trace. Failed and expected-to-fail compilations remain in the recording metadata. Two LLVM 20 mangling stress tests skip time tracing because expanding their type names can exhaust memory; perf still records them. Tests that copy the compiler, check its executable path or restrict file descriptors can fail under the wrapper. Recheck those with `CLANG` unset.

`provenance.json` records the source revision, compiler and build configuration. `metadata/` records each command, outcome and available profiles; `lit-results.json` records regression-suite results, including unsupported and failed tests. Test coverage depends on the host's tools and enabled targets. A recording is not a claim that all tests passed.

The full LLVM 20.1.8 recording contains 3,795 build compilations, 269 unit-test builds and 51,925 regression time traces, recorded at 1 ms / 49 Hz. The CPU report contains 30,275 sampled threads and 10.2 million stack segments. The build completed successfully. Of 46,315 discovered tests, 46,064 passed and 31 were expected failures; 50 failed under instrumentation. Correcting the launcher resolved 23 on retry. All 50 passed with the native compiler. Recordings include retries; two interrupted stress profiles were quarantined instead of included.

The [interactive sample](https://raw.githack.com/alexpaniman/violinoscope/main/docs/clang.html) and README screenshots use 192 build compilations, 128 unit-test compilations and 512 regression compilations, spaced across each group’s duration distribution. `PassBuilder.cpp` is retained for the detail views. The full recording remains the source for the counts above; the sample is for browsing, not aggregate benchmark results.

To open the bundled sample offline, open `docs/clang.html`. To refresh its UI screenshots with Playwright installed:

```sh
python3 examples/clang/capture.py docs/clang.html
```
