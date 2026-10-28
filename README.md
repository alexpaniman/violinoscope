# Violinoscope

Shows where traced work spends its time, from OpenTelemetry, Jaeger or Wilson spans. One kind of span is the unit
of work (a query compilation, a request); the page compares thousands of them: which spans under it take the time,
how that varies across units and workloads, and what happened inside any one of them.

```bash
# From span dumps: OTLP JSON, collector file exports, Jaeger JSON or Wilson's protobuf JSON lines.
python3 violinoscope.py suite=spans/ tpch=spans_tpch.jsonl --unit "Compile query" -o out/ \
    --left suite --right tpch --name suite="Benchmark suite"

# From a Jaeger query service, grouped by database.
python3 violinoscope.py --jaeger http://jaeger:16686 --service ydb --lookback 7200 --limit 5000 \
    --unit "Compile query" --group-by attr:db.namespace --jaeger-link http://jaeger:16686 -o out/
```

Open `out/index.html` from disk or serve the directory. The converter needs Python 3 only, and the page loads
nothing from outside `out/`.

## Options

| Option | Meaning |
|---|---|
| `NAME=PATH` | an input file, directory or glob; `NAME` becomes its dataset, and each input is a run on its own clock |
| `--unit SPAN` | the span that is one unit of work; without it, each trace's root |
| `--group-by` | `label` (the group in `--label-regex`, falling back to the input), `dataset`, or `attr:KEY`, an attribute's value |
| `--label-regex` | named groups `group` and `label` read from the query text, e.g. `'^--\s*(?P<group>\S+)\s+(?P<label>\S+), level'` |
| `--text-attr` | the attribute with query text (default `db.query.text`), for labels, fingerprints and the filters below |
| `--cpu-attr` | an attribute of the unit's span with its CPU time in microseconds, e.g. `ydb.cpu_us` |
| `--left`, `--right` | groups shown in the left and right halves of each violin (changeable in the page) |
| `--name GROUP=LABEL` | display name of a group or an input |
| `--run-label INPUT=LABEL` | a note on an input, such as the build it ran on |
| `--with-text` | keep query text for the drill-down; off by default because it may be sensitive |
| `--skip-text REGEX` | leave out units whose query text matches, such as warm-up runs |
| `--jaeger-link` | Jaeger UI base URL, for "Open in Jaeger" links |

## The page

- **Phases:** a violin per call path, one dot per unit, in share of the unit's time or in milliseconds. It starts
  with the unit's span and the spans it calls that take a fair share of its time. Under the violins:
  - a triangle opens a violin into the spans it calls, its larger ones, or closes it;
  - a + after everything under a violin lists its children not shown, largest first; typed text searches every level
    inside it: add them each, or as one violin, their time together, under a name. One made from every match of the
    text keeps it, and takes in new matches when the spans are read again; opened, a merged violin whose spans repeat
    names opens into those names first;
  - a name dragged onto another violin merges the two, or adds it to that one when it is merged already; Shift and a
    click on names picks several to merge;
  - a double-click on a name renames it, any violin, not only merged ones;
  - hovering a violin shows a × where its line meets its name, which hides it; its parent still counts the time;
  - a click on a name opens its card: what it is, its time, own time (what the violins under it don't count) and how
    often it occurs, in each half; runs against time when its spans run more than once in a unit (one dot per unit:
    how many runs, how much time, with lines of equal time per run), else its share against the unit's time; the five
    units that spend most in it (a click selects one, another opens the Timeline); a merged violin's members, each to
    take out; and hiding, renaming, splitting up, or finding its span in the Spans tab.
- **Projections**, a second tree to the right, for violins that cut across the first: any spans, from its own + or a
  name dragged onto it, merged as you like, the same span in both trees if need be. It takes nothing from the first
  tree: the split of a unit's time (Parts by time) and the colours stay the first tree's. A what-if factor on a
  violin of each tree applies, multiplied, where both own the time.

  The left and right halves are two sets of groups. Below them, "When it runs": each unit stretched to the same
  height, start at the top, and how often each violin is running at each point of it. A what-if factor on any violin
  projects every view.
- **Download** (the icon at the top right): the page as one HTML file, its data inside, opening with the violins
  as they are; it works from disk, and downloads itself again the same way. The root's card goes back to the
  violins a page was saved with, or starts over. A viewer's own changes are kept in their browser until they open a
  page saved after them.
- **Timeline:** the units in view laid out in time, each run on its own clock, as a flame chart or as a waterfall
  with a row per span.
- **Spans:** a table of span names or call paths with self and total time, the merged flame graph of the
  selection, and the callers and callees of a picked span.

The chip for the unit's time filters units by duration; its card shows, under the histogram, how the unit's time
splits among the first tree's violins at each duration (Parts by time).

A violin's time in a unit is the time its spans cover there, overlaps counted once, cut to the unit; a merged violin's
is its members' together. For the split of a unit's time ("Parts by time", the what-if), each moment counts toward
the deepest violin shown that covers it.

## Tests

```bash
python3 -m unittest discover tests                  # the converter, on made-up traces
python3 tests/synth.py /tmp/a.jsonl --group alpha   # made-up traces to try the page on
python3 violinoscope.py a=/tmp/a.jsonl --unit "Handle request" -o out/
tools/with-browser.sh tests/browser_check.py out/ --shots shots/   # build and share violins, every tab, no errors
```

`tests/browser_check.py` needs Playwright for Python with its Chromium; put machine-specific paths in
`tools/browser.env` (ignored by git), which `tools/with-browser.sh` reads.

## Files

- `violinoscope.py`: the converter. It reads spans, cuts them into units, and writes `out/data/` (a summary of the
  units, their span trees in chunks, and an empty `layout.js`, the violins a page starts with, unless one is there
  already) and `out/index.html`, `web/index.html` with the page's scripts and styles inside it.
- `web/`: the page, plain scripts sharing `window.TX`:
  - `core.js`: state, data access, columns, scales and the what-if;
  - `layout.js`: the violins from the span trees: call paths, what is shown and merged, each unit's time in them;
  - `violins.js`, `edit.js` and `gl.js`: the Phases tab, changing what it shows, and its dots on the GPU;
  - `download.js`: the page as one file, with the violins as they are;
  - `timeline.js`, `flame.js`, `nav.js`: the waterfall, flame chart, flame graph and the overview strip;
  - `spans.js`: the spans table and callers and callees;
  - `panel.js`: cards; `main.js`: controls, the time range card and keys;
  - `render.js`, `model.js`: density estimation, scales and shared drawing.
- `tools/artifact_page.py`: writes `artifact.html`, the page without its document skeleton, for hosting as a
  claude.ai artifact; `tools/write_page.py OUT` writes `OUT/index.html` again from `web/`, keeping the data.
