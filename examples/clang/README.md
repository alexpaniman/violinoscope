# Compile fmt with Clang

The README image compares 28 compilations each at `-O0` and `-O2`: 14 translation units from [fmt 11.2.0](https://github.com/fmtlib/fmt/tree/11.2.0), compiled twice with Clang 20.1.8. Each dot is one translation unit. The report contains about 638,000 spans; tracing omits events shorter than 100 µs. These are local observations, not a portable compiler benchmark.

From the Violinoscope checkout:

```sh
git clone --depth 1 --branch 11.2.0 https://github.com/fmtlib/fmt.git /tmp/fmt
python3 examples/clang/collect.py /tmp/fmt /tmp/fmt-traces --compiler clang++
python3 violinoscope.py 'O0=/tmp/fmt-traces/O0/*.json' 'O2=/tmp/fmt-traces/O2/*.json' \
  --unit ExecuteCompiler --left O0 --right O2 \
  --layout examples/clang/phases.layout.json --title 'Compiling fmt' -o fmt.html
```

The collection runs sequentially, alternating optimization levels. `--repeats`, `--flags`, `--launcher` and `--resume` cover repetition, toolchain flags, a compiler launcher and interrupted collections. Keep compiler/version/flags fixed when resuming. A compiler, C++ headers and Python 3.9+ are required; linking fmt or installing it is unnecessary.

The layout groups templates and separates parsing, optimization, inlining and code generation. Span names stay available in Made of. Shares are exclusive between siblings, including recursive template calls; individual Clang aggregate counters cannot be summed this way.

For [perf CPU sampling](../../docs/collecting.md#linux-perf), `cpu.layout.json` offers a small Clang breakdown. Use `--layout examples/clang/cpu.layout.json`; symbol names depend on the compiler build. Missing or truncated stack frames remain unexplained, and these measurements are sampled CPU time rather than elapsed compilation phases.
