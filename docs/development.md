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

Measured in Chromium at 1600×1050 (timings include two animation frames):

| Recording | Load | Move / reorder | Add 75 names | Flame pan | Critical-path toggle |
| --- | --- | --- | --- | --- | --- |
| 822,426 spans, 6,586 units, 189 paths | 4.4 s | 133 / 33 ms | 1.01 s | 21–35 ms | 52 ms |
| Clang: 637,678 spans, 56 units, 1,266 paths | 3.1 s | 50 / 33 ms | 190 ms | 28–37 ms | 34 ms |

Drag handlers stayed below 4 ms. Retained JS heap was about 142 MB and 24 MB respectively. A separate 109,379-span compilation loaded in 0.75 s. These are measured workloads, not limits: the number of units, paths and visible columns matters as much as span count. Bulk edits across thousands of runs still take longer than a frame.

The flame chart caches compact visible-depth rows; aggregate profiles avoid per-occurrence objects. Detailed span objects use a row-bounded LRU. Embedded chunks are JSON-parsed incrementally, and sequential traces share their main/projection interval index. The critical-path engine caches sparse causal graphs per trace; 100,001 ordinary spans required two vertices and about 25 ms. Its fixtures and 10,000 randomized fork/join graphs check coverage, joins, resumption delay, unjoined work, missing links and cycles.
