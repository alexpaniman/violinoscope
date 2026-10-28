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
  - a triangle opens a violin into the spans it calls, its larger ones, or closes it; closed, what was under it waits
    for it to open again; opened, it stays open with all of them hidden, its + there to add just the ones wanted;
  - a + after everything under an open violin lists what is not shown: its children, then, apart, everything deeper
    inside, each largest first and with an All; typed text filters both. Add them each, or as one violin, their time
    together, under a name, or exclude them from the violin's time. One made from every match of the
    text keeps it, and takes in new matches when the spans are read again. A merged violin is made of spans only, and
    stays until removed. Spans merged that are all inside a merged violin, from its + or picked there, make its child
    and stay in it: Compute types inside Compute *;
  - a name dragged onto a sibling moves past it, with everything under it, and onto Projections copies it there;
    Shift and a click on names, or anywhere along a violin off its dots, picks violins, and a click elsewhere lets
    them go. Picked, they merge into one violin, closed, get a new parent above them, still shown, go back under the
    span that holds them all when it was removed, or are removed;
  - a double-click on a name renames it, any violin, not only merged ones; a merged violin's name is followed by how
    many spans it merges;
  - hovering a violin shows a × where its line meets its name, which removes it, its parent still counting the time;
    removed, nothing about it or under it is kept, and added again it comes back as its spans are called. Open with
    children shown, it removes just its level: they move up to its parent. A card's path shows such levels muted, and
    a click puts one back with what is under it; a merged violin whose spans all run in one span not on screen can be
    made that span. Shift and a click on names picks several, to remove at once (Delete) or merge;
  - a click on its name, or anywhere along its column off the dots, opens its card: its name, to edit, and where it
    sits, with Split up (its larger spans shown, the rest behind a +) and In Spans (callers and callees) at the top;
    its time summed over the units in view and its share of theirs, per half (the root's: how many units, their time);
    its share against the unit's time (one dot per unit); runs against time when how many times its spans run
    differs between units (one dot per unit: runs and time, with lines of equal time per run), else what the count
    always is; and what it is made of, on one line until opened: its spans, with the span each runs under and its
    average share of the unit's time, each to take out of a merged violin, and the spans excluded from its time,
    each to put back. Its + includes more spans, from anywhere, or excludes spans inside it from its time.
- **Projections**, after a gap to the right, violins that cut across the tree and take nothing from it: any spans,
  from the small dashed + at the side or a name dragged onto it, merged as you like, the same span in both places if
  need be. The split of a unit's time (Parts by time) and the colours stay the tree's. A what-if factor on a violin
  of each applies, multiplied, where both own the time.

  The left and right halves are two sets of groups. Below them, "When it runs": each unit stretched to the same
  height, start at the top, and how often each violin is running at each point of it. A what-if factor on any violin
  projects every view.
- **Picture** (in Phases, the icon at the top right): the violins, tree and strips as a PNG, with the title and key.
- **Download** (the icon beside it): the page as one HTML file, its data inside, opening with the violins
  as they are; it works from disk, and downloads itself again the same way. The root's card goes back to the
  violins a page was saved with, or starts over. A viewer's own changes are kept in their browser until they open a
  page saved after them.
- **Timeline:** the units in view laid out in time, each run on its own clock, as a flame chart or as a waterfall
  with a row per span. Dragging across the strip at the top shows that stretch; Esc goes back, All shows everything.
- **Spans:** a table of span names or call paths with self and total time, the merged flame graph of the
  selection, and the callers and callees of a picked span.

The chip for the unit's time filters units by duration; its card shows, under the histogram, how the unit's time
splits among the first tree's violins at each duration (Parts by time): its leaves, but a parent in place of its
children where at most one of them matters (wide somewhere, or on average), and what stays small in Other.

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
