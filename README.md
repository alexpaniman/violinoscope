# Violinoscope

Shows where traced work spends its time, from OpenTelemetry, Jaeger or Wilson spans. One kind of span is the unit
of work (a query compilation, a request); the page compares thousands of them: which parts take the time, how that
varies across units and workloads, and what happened inside any one of them.

```bash
# From span dumps: OTLP JSON, collector file exports, Jaeger JSON or Wilson's protobuf JSON lines.
python3 violinoscope.py suite=spans/ tpch=spans_tpch.jsonl -o out/ \
    --left suite --right tpch --name suite="Benchmark suite"

# From a Jaeger query service (group by database; no query text by default).
python3 violinoscope.py --jaeger http://jaeger:16686 --service ydb --lookback 7200 --limit 5000 \
    --group-by database --jaeger-link http://jaeger:16686 -o out/
```

Open `out/index.html` from disk or serve the directory. The converter needs Python 3 only, and the page loads
nothing from outside `out/`.

## Options

| Option | Meaning |
|---|---|
| `NAME=PATH` | an input file, directory or glob; `NAME` becomes its dataset, and each input is a run on its own clock |
| `--profile` | which span is a unit and how span names map to parts (default: `profiles/kqp_compile.json`) |
| `--group-by` | `label` (the profile's pattern in the query text, falling back to the dataset), `database` or `dataset` |
| `--left`, `--right` | groups shown in the left and right halves of each violin (changeable in the page) |
| `--name GROUP=LABEL` | display name of a group or an input |
| `--run-label INPUT=LABEL` | a note on an input, such as the build it ran on |
| `--with-text` | keep query text for the drill-down; off by default because it may be sensitive |
| `--skip-text REGEX` | leave out units whose query text matches, such as warm-up runs |
| `--jaeger-link` | Jaeger UI base URL, for "Open in Jaeger" links |

## The page

- **Phases:** a violin per part, one dot per unit, in share of the unit's time or in milliseconds. The left and
  right halves are two sets of groups; under the violins, the tree of parts and when in the unit each part runs.
  A what-if factor on any part projects every view.
- **Timeline:** the units in view laid out in time, each run on its own clock, as a flame chart or as a waterfall
  with a row per span.
- **Spans:** a table of span names or call paths with self and total time, the merged flame graph of the
  selection, and the callers and callees of a picked span.

The compile-time chip filters units by duration and shows how the parts' shares change with it.

## A profile

For now the parts come from a profile file. This is going away: the page will build its violins from the call tree
itself, with only the unit span given on the command line.

- `root`: the span that is one unit of work.
- `columns`: the parts, matched by span `names` or `prefix`, with an optional `parent`. Special matchers:
  `union_of` (the union of other parts), `uncovered_by` (time under none of the listed parts) and `after_nth`
  (spans after the nth anchor span).
- `partition`, `partition_priority`, `families`: the non-overlapping split behind "Parts by time".
- `query_text`, `attributes`, `failure`: where the query text, CPU time, database and failure reason are read from.

## Tests

```bash
python3 -m unittest discover tests                  # the converter, on made-up traces
python3 tests/synth.py /tmp/a.jsonl --group alpha   # made-up traces to try the page on
python3 violinoscope.py a=/tmp/a.jsonl --profile tests/profile.json -o out/
tools/with-browser.sh tests/browser_check.py out/ --shots shots/   # every tab in headless Chromium, no errors
```

`tests/browser_check.py` needs Playwright for Python with its Chromium; put machine-specific paths in
`tools/browser.env` (ignored by git), which `tools/with-browser.sh` reads.

## Files

- `violinoscope.py`: the converter. It reads spans, cuts them into units, and writes `out/data/` (a summary,
  per-name totals, and the span trees in chunks) next to a copy of `web/`.
- `web/`: the page, plain scripts sharing `window.TX`:
  - `core.js`: state, data access, columns, scales and the what-if;
  - `violins.js` and `gl.js`: the Phases tab (SVG and WebGL dots);
  - `timeline.js`, `flame.js`, `nav.js`: the waterfall, flame chart, flame graph and the overview strip;
  - `spans.js`: the spans table and callers and callees;
  - `panel.js`: cards; `main.js`: controls, the compile-time card and keys;
  - `render.js`, `model.js`: density estimation, scales and shared drawing.
- `tools/artifact_page.py`: writes `artifact.html`, the page without its document skeleton, for hosting as a
  claude.ai artifact.
