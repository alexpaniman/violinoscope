# Compiling LLVM

The README image compares compiling LLVM library files with compiling its unit tests. Each dot is one source file. Templates and repeated optimization passes are extracted into top-level groups; their time is subtracted from the broader phases. The CPU layout makes the same comparison from sampled stacks.

Collected with Clang 20.1.8 against LLVM `llvmorg-20.1.8` (`87f0227cb601`), Release flags: 32 evenly spaced files from `llvm/lib/Support` and 32 from `llvm/unittests/ADT`. This is a representative compilation subset, not a full LLVM build or a run of the test executables. It produced 255,163 time-trace spans. Perf produced 207,281 stack segments across 63 files; one very short file had no samples.

Configure with an installed Clang, CMake and Ninja, then generate the headers needed by the selected files:

```sh
git clone --depth 1 --branch llvmorg-20.1.8 https://github.com/llvm/llvm-project.git /tmp/llvm-project
cmake -G Ninja -S /tmp/llvm-project/llvm -B /tmp/llvm-build \
  -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DLLVM_TARGETS_TO_BUILD=X86 -DLLVM_INCLUDE_BENCHMARKS=OFF
cmake --build /tmp/llvm-build --target intrinsics_gen
python3 examples/clang/collect_build.py /tmp/llvm-build/compile_commands.json /tmp/llvm-traces \
  --group 'LLVM=llvm/lib/Support/*.cpp' --group 'Tests=llvm/unittests/ADT/*.cpp' --perf
```

`--perf` requires Linux perf access; omit it for time traces alone. Collection is sequential. If installed, `--launcher 'balance-exec --kind compile --'` shares the machine's build resources. `--limit 0` collects every matching file; the default is 32 per group. Other source trees work through their compilation database, provided generated headers already exist.

```sh
python3 violinoscope.py 'LLVM=/tmp/llvm-traces/LLVM/*.json' 'Tests=/tmp/llvm-traces/Tests/*.json' \
  --unit ExecuteCompiler --left LLVM --right Tests --layout examples/clang/phases.layout.json \
  --title 'Clang compiling LLVM' -o clang.html
python3 violinoscope.py 'LLVM=/tmp/llvm-traces/LLVM/*.perf.txt.gz' 'Tests=/tmp/llvm-traces/Tests/*.perf.txt.gz' \
  --unit 'Sampled CPU' --left LLVM --right Tests --layout examples/clang/cpu.layout.json \
  --title 'Clang CPU samples' -o clang-cpu.html
```

Time traces retain events lasting at least 100 µs; perf samples CPU at 199 Hz with DWARF stacks. Both are adjustable. Sampled widths exclude waits and scheduling gaps; the Samples tab shows stack order on a CPU-time axis. Unknown frames remain visible. Very short functions may receive no samples.

The output retains exact commands, compiler versions, source hashes, logs and per-file metadata. `--resume` reuses completed files with matching commands/source hashes; use a new output directory if headers or the toolchain changed. Failed compilations stop collection. Empty perf recordings are kept under `metadata` and omitted from the CPU report.

The older `collect.py` helper remains available for fmt 11.2.0: it compares 14 translation units at `-O0` and `-O2`, twice each. Its input is a fmt checkout and an output directory; use the same phase layout and `ExecuteCompiler` unit.
