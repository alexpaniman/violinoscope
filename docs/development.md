# Development

The converter uses Python's standard library. The page is plain JavaScript, CSS, SVG and canvas; its scripts share `window.TX`. The layout model and flow classifier are independent of drawing.

```sh
python3 -m unittest discover tests
node tests/layout_check.js
```

The model checks include interval conservation, transfers, nested merges, exclusions, inherited async flows, exact undo and 5,000 random edits by default. `FUZZ_SEEDS=500 node tests/layout_check.js` runs 50,000 edits, including typed input changes and exact undo/redo.

They also exercise a 75-part projection across 1,500 units. Run `CHECK_PERFORMANCE=1 node tests/layout_check.js` to enforce a three-second budget for adding and first opening it on a development machine.

For browser checks, install Playwright and Chromium in your Python environment:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/synth.py /tmp/example-spans.jsonl --traces 200
python3 violinoscope.py /tmp/example-spans.jsonl --unit "Handle request" -o out-synthetic
python3 tests/browser_check.py out-synthetic
python3 tests/browser_regressions.py out-synthetic
python3 tests/parts_check.py out-synthetic
python3 tests/flows_check.py
python3 tests/layout_files_check.py
python3 tests/definition_editor_check.py
```

`tools/with-browser.sh` optionally loads `tools/browser.env` for machine-specific browser paths. That file is ignored by Git.

To iterate on the page without reading traces again, generate directory output and run `python3 tools/write_page.py OUT_DIR` after editing `web/`. The resulting `index.html` is still self-contained. `--split-data` leaves chunks external when testing deferred loading.

`layouts.py` and `web/layout-files.js` implement the same portable layout format. Changes to its references or validation should cover both import paths.

The separate definition validator checks ownership, source scope, cycles and fixed-unit rules before committing an edit. The Python importer and browser importer share acceptance fixtures. The browser tests also cover clipboard/file layouts, absent inputs, source/reference previews and factor labels in exported PNGs.

A measured full report contained 822,426 span occurrences, 6,586 units and 190 distinct call paths. In Chromium 156 on the development machine, it loaded in about 3.2 seconds. Adding a 75-input projection took 2.0 seconds, opening it 0.34 seconds, showing all inputs 1.35 seconds and changing its factor 2.6 seconds. The JavaScript heap after collection was about 319 MiB. These are measured examples, not a hard capacity guarantee: unit count, distinct paths and visible columns matter more than span count alone. Workloads near a million occurrences with a few hundred paths are the tested scale; millions of distinct paths are not.

Repeat the measurement on a report with at least 75 matching Compute paths:

```sh
python3 tests/performance_check.py report.html --output performance.json
```
