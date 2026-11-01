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

Measured in headless Chromium at 1600×1050, with software rendering; actions include two animation frames:

| Recording | Load | Move / reorder | Add 75 names | Open chart | Expand full table tree |
| --- | --- | --- | --- | --- | --- |
| Request traces: 822,426 spans, 6,586 units | 4.5 s | 150 / 33 ms | 1.06 s | 104 ms | 33 ms |
| Clang build: 7,621,663 spans, 4,064 units | 21.9 s | 266 / 33 ms | 1.62 s | 676 ms | 33 ms |
| Clang CPU: 8,462,574 segments, 3,669 units, 609,569 paths | 32.0 s | 700 / 347 ms | 1.11 s | 249 ms | 1.92 s |

With all groups enabled, the 55,989-unit time-trace report loads in about 29 s. Move/reorder take 379/83 ms, adding 75 names takes 4.0 s, expanding them takes 2.8 s, and the automatic breakdown opens in 1.2 s. The final CPU report has 10,208,253 segments across 30,275 units: load 42.5 s, breakdown 4.9 s, chart 68 ms, flamegraph 2.7 s, table 2.3 s and waterfall 485 ms.

Large recordings still exceed the test's 2 s action budget. First configured/group CPU pickers take 6–10 s; dissolving a group into independent projections takes about 6 s. Picker calculation yields between previews and lists render only visible rows; cold index preparation can still pause for about 2 s. Cached searches are immediate. These limits are recorded rather than hidden by raising the test budget.

Path diversity, stack depth, unit count and visible columns matter as much as span count. These measurements describe tested workloads, not a capacity guarantee. Retained heap on the large CPU fixture is about 1.6 GB. Drag handlers stay below 4 ms. After bounding minimap work to pixels, waterfall scrolling takes about 33 ms instead of occasionally stalling for 20 s.

Containment uses direct edges and lazy recursive-name reachability; picker previews revisit affected routes and interval patterns. Call paths use compact parent/name keys. Breakdown rows and interpolation coefficients are sparse; curve sums preserve the same monotone interpolation and partition. Tables, pickers and waterfalls render viewport rows. Offline HTML embeds compressed data; the browser decompresses one chunk at a time. These changes do not alter allocation rules.

The browser checks cover actual tab state (including perf Samples), deep chart scrolling, all profile views, table search/expansion/scrolling, critical paths, drag editing and offline export. Model fuzzing checks snapshot undo, cold recomputation and picker previews against actual edits. Critical-path fixtures and 10,000 randomized fork/join graphs check coverage, joins, resumption delay, unjoined work, missing links and cycles; 100,001 sequential spans take about 26 ms.
