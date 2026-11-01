# Development

Python standard library; plain JavaScript, SVG and canvas. No build step for the page. `web/tree-model.js` contains the saved tree and edit operations; `web/layout.js` derives occurrence allocation and measurements. `definition-model.js` is retained for importing older layouts and interval factor composition.

```sh
python3 -m unittest discover tests
FUZZ_SEEDS=500 node tests/layout_check.js
node tests/critical_check.js
```

The model checks include recursion, scoped extraction, independent projections, mixed async flows, interval bounds, exact undo/redo and cold-recompute comparisons. The command above runs 75,000 random edits. Python and browser layout validators share acceptance fixtures.

Install Playwright and Chromium in your development environment, then:

```sh
python3 tests/synth.py /tmp/spans.jsonl --traces 200
python3 violinoscope.py /tmp/spans.jsonl --unit 'Handle request' -o out-synthetic
python3 tests/browser_check.py out-synthetic
python3 tests/layout_files_check.py
python3 tests/parts_check.py out-synthetic
python3 tests/flows_check.py
python3 tests/causal_check.py
python3 tests/profiler_check.py
python3 tests/flame_check.py
python3 tests/leaf_check.py
```

`tools/with-browser.sh` can load local browser paths from the ignored `tools/browser.env`. For an existing report directory, `python3 tools/write_page.py OUT_DIR` refreshes the self-contained HTML without converting traces again.

Measure a real report with:

```sh
python3 tests/performance_check.py report.html --stress --output performance.json
```

Measured in Chromium at 1600×1050; actions include two animation frames:

| Recording | Load | Move / reorder | Add 75 names | Open chart | Expand full table tree |
| --- | --- | --- | --- | --- | --- |
| YDB: 822,426 spans, 6,586 units | 4.5 s | 150 / 33 ms | 1.06 s | 104 ms | 33 ms |
| LLVM time traces: 255,163 spans, 64 files | 2.5 s | 33 / 33 ms | 170 ms | 107 ms | 33 ms |
| LLVM perf: 207,281 segments, 63 files, 48,768 paths | 2.2 s | 116 / 33 ms | 134 ms | 107 ms | 183 ms |

Drag handlers stayed below 4 ms. Retained JS heap was about 143, 15 and 165 MB respectively. A first picker calculation in an already populated perf layout takes 0.9–1.0 s for roughly 4,900 names; subsequent searches use its cached results. Panning ranged from 20–80 ms including animation frames. These are tested workloads, not capacity guarantees: path diversity, stack depth, unit count and visible columns matter as much as span count.

The perf fixture exposed a 12 s startup from eager name-graph closure and a 13 s expanded-table render. Recursive name components now share lazy reachability; picker previews revisit only affected routes and interval patterns. The table and waterfall render viewport rows, and chronological charts index complete stacks by depth/time instead of truncating at eight levels. Text measurements are bounded and cached. None of these changes alters allocation rules.

The browser checks cover actual tab state (including perf Samples), deep chart scrolling, all profile views, table search/expansion/scrolling, critical paths, drag editing and offline export. Model fuzzing checks snapshot undo, cold recomputation and picker previews against actual edits. Critical-path fixtures and 10,000 randomized fork/join graphs check coverage, joins, resumption delay, unjoined work, missing links and cycles; 100,001 sequential spans take about 26 ms.
