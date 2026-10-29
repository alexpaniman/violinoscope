# Development

The converter uses Python's standard library. The page is plain JavaScript, CSS, SVG and canvas; its scripts share `window.TX`. The layout model and flow classifier are independent of drawing.

```sh
python3 -m unittest discover tests
node tests/layout_check.js
```

The model checks include interval conservation, transfers, nested merges, exclusions, inherited async flows, exact undo and 5,000 random edits.

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
```

`tools/with-browser.sh` optionally loads `tools/browser.env` for machine-specific browser paths. That file is ignored by Git.

To iterate on the page without reading traces again, generate directory output and run `python3 tools/write_page.py OUT_DIR` after editing `web/`. The resulting `index.html` is still self-contained. `--split-data` leaves chunks external when testing deferred loading.

`layouts.py` and `web/layout-files.js` implement the same portable layout format. Changes to its references or validation should cover both import paths.
