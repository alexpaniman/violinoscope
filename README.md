# Violinoscope

Compare where time goes across thousands of traced requests. Build your own breakdown, compare groups, and open any request in a flame chart or waterfall.

![Compiler phase distributions for fmt, comparing Clang -O0 and -O2](docs/clang-phases.png)

[Reproduce this Clang example](examples/clang/README.md): 56 compilations, about 638,000 spans, one offline page.

```sh
python3 violinoscope.py before.jsonl after.jsonl --unit "Handle request" -o report.html
```

Open `report.html` in a browser. It contains everything and works offline. Python 3.9+ is the only build dependency; no server or JavaScript build step.

Inputs include OTLP/Collector JSON, Jaeger JSON, Chrome/Clang time traces, and time-based Linux perf exports. Gzip, directories and quoted globs work. Dataset names come from `dataset.name`, then `service.name`, then filenames; `baseline=before.jsonl` supplies an explicit name. Omit `--unit` when trace roots all have the same name.

The layout icon between the picture and download buttons manages named layouts. Edits autosave; copy/paste JSON to share them, or Shift-click the import/export icons to use files. Drop a layout file onto the page, or use it when building:

```sh
python3 violinoscope.py spans.jsonl --unit "Handle request" --layout overview.layout.json
```

Start at the unit root and use **+** to explore. Drag siblings together to group them, move a span upward to extract its share, or use Projections for an independent view. × deletes; hide keeps a node in the calculation.

The default output is `violinoscope.html`. Downloading from the page includes its current layout. Ctrl+Z undoes edits; Ctrl+Shift+Z redoes them.

[Collect local or cluster traces](docs/collecting.md) · [How time is counted](docs/model.md) · [Development and tests](docs/development.md)

Run `python3 violinoscope.py --help` for grouping, comparison and labeling options. Query text is omitted from reports unless `--with-text` is given.
