# Development

Python standard library; plain JavaScript, SVG and canvas. No build step for the page. `web/tree-model.js` contains the saved tree and edit operations; `web/layout.js` derives occurrence allocation and measurements. `definition-model.js` is retained for importing older layouts and interval factor composition.

```sh
python3 -m unittest discover tests
FUZZ_SEEDS=500 node tests/layout_check.js
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
```

`tools/with-browser.sh` can load local browser paths from the ignored `tools/browser.env`. For an existing report directory, `python3 tools/write_page.py OUT_DIR` refreshes the self-contained HTML without converting traces again.

Measure a real report with:

```sh
python3 tests/performance_check.py report.html --output performance.json
```

A Chromium run on 822,426 occurrences, 6,586 units and 190 call paths loaded in 4.1 seconds. Single addition took 83 ms including rendering; expansion 71 ms, reordering 110 ms, movement 189 ms and grouping 264 ms. Adding eight columns took 445 ms; restoring the 27-column layout took 881 ms. Pointer drag handling peaked below 1 ms. These are machine-specific observations, not hard limits. Roughly one million occurrences with hundreds of paths is the tested scale; large numbers of distinct names or visible columns need their own measurements.
