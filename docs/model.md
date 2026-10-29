# Time and layouts

A unit is one occurrence of the span selected with `--unit`. A violin describes a call path or a combination of paths and shows its distribution across units. The root gives the elapsed-time budget; it is not a measurement of CPU consumption.

The main tree partitions that budget. Extracting paths into another main-tree violin transfers their coverage out of their former owners. Intermediate parents measure their remaining coverage. A merged violin retains its parts and their exclusions; overlapping intervals count once. Projections measure independent combinations and take nothing from the main tree.

Opening, closing and hiding change what is displayed. Hidden intermediate and merged violins retain their definitions and assignments; the **+** picker restores them. Empty definitions also survive. Taking a member out through **Made of**, excluding a span, splitting a merge, or moving a projection into the main tree changes the model. A main-tree move offers only destinations that contain all its spans, with a preview of the transfer. Keyboard undo restores exact layout snapshots.

A merge retains the effective definitions selected, including exclusions inherited from a level they leave. Exclusions subtract intervals after union: excluding a part is not equivalent to removing its input when another input overlaps it. Taking an input out changes all derived ancestors that depend on it; it is not silently inserted into an outer merge.

Own time belongs to the deepest shown violin covering an interval. What nothing covers completes the elapsed-time budget. The automatic time breakdown uses the whole underlying tree, independently of which violins are open.

## Automatic time breakdown

A part normally earns a label if its mean share reaches 10% somewhere along the duration axis, or averages 5% across that axis. The same rule applies recursively. A child covering at least two thirds of a meaningful remainder can explain it more specifically than its parent.

Small contributions collect in Other. If Other averages at least 15% and has enough vertical label space, up to two more named parts can be shown, each averaging at least 1.5%. The remaining Other still contains every unlabelled interval. Hover a band or label to see its contributions. These are descriptive heuristics, not statistical significance tests.

## Async work

Ordinary OpenTelemetry parent/child relationships do not specify whether the parent waits or continues running. No span name is special-cased.

The optional custom attribute `span.flow=async` starts a logical flow; unmarked descendants inherit it. This does not prove parallel execution. A marked unit root still defines its own budget. `--flow-attr` changes the attribute name when importing existing instrumentation.

Links can use the custom `span.link.relation` attribute with `depends_on` or `follows_from`. `--link-relation-attr` changes that name. Neither custom attribute is an OpenTelemetry semantic convention.

A flow with explicit `depends_on` links to its direct child flows is treated as a dependency group. Under a main-flow phase, its elapsed coverage is clipped to that phase and can appear beneath it. This does not infer the precise interval during which the parent was suspended. The child requests remain independent measurements in Projections, including their tails beyond the parent. Groups under an independent flow remain independent too.

Flame charts, waterfall rows and the spans table keep flow boundaries and inherited membership. Callers/callees split independent flows into separate graphs, with links back to their starting context. A half-filled indicator in the table means a name has occurrences in both main and separate flows. Zooming changes the time scale; it does not remove waterfall rows belonging to selected units.

Independent work has no individual latency what-if without a critical-path model. A factor on an enclosing main-tree phase still applies to all its coverage, including dependency groups.

## Saved layouts

The icon opens a small layout library. Save updates the entered name; entering a different name makes a new preset. Switching presets is undoable. The dot beside the icon means the working layout differs from its saved preset.

Browser storage keeps the working copy and presets locally. File exports keep only the layout definition: its name, root span, paths, merges, exclusions, ordering and visibility. They contain no traces or query text. Paths absent from a dataset are retained in the exported definition so the layout can be reused on a fuller dataset. A different root span is rejected.

Reports embed their default layout. An existing local working copy takes precedence only when it belongs to the same embedded default. For a report you intend to share, use the download icon to capture the current definition.
