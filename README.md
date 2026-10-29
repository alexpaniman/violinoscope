# Violinoscope

Compare where time goes across thousands of traced requests. Build your own breakdown, compare groups, and open any request in a flame chart or waterfall.

```sh
python3 violinoscope.py before.jsonl after.jsonl --unit "Handle request" -o report.html
```

Open `report.html` in a browser. It contains everything and works offline. Python 3.9+ is the only build dependency; no server or JavaScript build step.

Inputs can be OTLP JSON, OpenTelemetry Collector JSON lines, Jaeger JSON, individual protobuf-JSON spans, or gzip versions of these. Files, directories and quoted globs work. Dataset names come from `dataset.name`, then `service.name`, then filenames; `baseline=before.jsonl` supplies an explicit name. Omit `--unit` when trace roots all have the same name.

The layout icon between the picture and download buttons saves, switches, imports and exports named layouts. Edits autosave in your browser; export JSON to share or keep them. Drop a layout file onto the page, or use it when building:

```sh
python3 violinoscope.py spans.jsonl --unit "Handle request" --layout overview.layout.json
```

The default output is `violinoscope.html`. Downloading from the page includes its current layout. Ctrl+Z undoes edits; Ctrl+Shift+Z redoes them.

[Collect local or cluster traces](docs/collecting.md) · [How time is counted](docs/model.md) · [Development and tests](docs/development.md)

Run `python3 violinoscope.py --help` for grouping, comparison and labeling options. Query text is omitted from reports unless `--with-text` is given.
