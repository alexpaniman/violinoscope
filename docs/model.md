# Time and layouts

A unit is one occurrence of the span selected with `--unit`. Each unit is analyzed separately, even when units overlap in clock time. Labels come from the unit, its enclosing request, then its descendants; another request in the same trace cannot supply its label. The root is a fixed elapsed-time budget, not CPU consumption.

A violin is the union of its inputs, minus its span exclusions. **Recorded span** inputs read a complete call path from the recording. **Violin** inputs follow another violin's edited definition by identity. They can be mixed in the same recipe. Made of marks the two kinds and offers an explicit replacement picker with a time preview; matching names never create a dependency.

The main analysis transfers extracted coverage out of former branches. A recorded parent keeps its recorded basis minus those transfers. A parent defined by other violins follows changes to those inputs. Each projection is an independent analysis: overlapping projections neither steal inputs nor reduce the main tree. Moving a projection into the main tree adopts that tree's ownership rule.

There are two distinct measures. The violin curves show **coverage**: a union of intervals, clipped to its containing context and reduced by exclusions and transfers. Sibling coverage can overlap. **Own parts** assign each moment to one deepest modeled or displayed owner; only these attributed parts, together with the remainder, sum to 100%. For example, recorded A (60 ms) and B (50 ms) overlapping by 20 ms have a 90 ms union. Their attributed parts can be 60 and 30 ms, plus a root remainder of 10 ms. The tool does not silently relabel B's recorded 50 ms as 30 ms.

Opening, closing, reordering, renaming and hiding change presentation. Hidden definitions and intermediate levels survive; restore them with **+** or the card's breadcrumbs. Empty definitions survive too. Row order and names never decide which overlapping branch gets attributed time.

Merge keeps complete typed inputs and places the new definition at their common containing level, including hidden levels. Moving or copying preserves inherited exclusions, containing bounds and transferred holes. Captured cuts are small interval recipes, not dataset-specific numeric samples. Copies remain independent of later edits to the original. Explicit exclusions are applied after union: excluding A is different from removing A when B also covers A's intervals.

Removing an input changes the recipe and its dependent ancestors; it does not silently insert that input into an outer merge. Split up dissolves an unmodified wrapper while preserving input types. A wrapper with exclusions or captured constraints instead offers **Show parts**: its display level disappears, while the definition continues enforcing its constraints. This avoids losing cuts or applying them to unrelated siblings. The previous implicit Make it conversion is replaced by the explicit input picker.

Placement stays fixed when a recipe becomes smaller or empty. A released input returns to its recorded parent when that parent can still contain it; otherwise it returns to a supporting ancestor. If that would create a cycle, it uses the former owner's surrounding level. It retains the bounds and exclusions of the context it leaves.

**Rest of P** is available only for a recorded input. It is that input's remaining coverage outside its model children, regardless of which children are visible. Removing or replacing the recorded input removes its Rest row. Rest cannot be merged or used as an input. A source replacement that would put an edited source violin outside its new containing recipe is rejected with an explanation; restore that violin's source input first.

Undo and redo restore complete snapshots, including hidden definitions, placement and what-if factors. Hidden factors remain active. Factors within one analysis follow its attribution; factors from independent analyses multiply on their interval intersections. This is a latency scenario, not a simulation of scheduling or a critical path.

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

The layout icon opens a compact list. Edits autosave into the selected layout. **+** creates another layout from the current state; double-click its name or press F2 to rename it. Drag its handle, or use Alt+↑/↓ on its name, to reorder. The row's × removes the saved entry.

Header icons copy or paste a portable JSON layout. Shift-click them to download or open a file; browsers without clipboard access fall back to files. Dropping a layout file onto the page also imports it. The picture button copies a PNG including visible what-if factors; Shift-click downloads it.

Layout files contain names, paths, typed inputs, captured cuts, ordering and visibility, with no traces or query text. Absent paths remain editable zero-valued inputs. Removing one removes it from subsequent exports. A different unit root is rejected. Runtime source descriptors from one preset do not leak into another preset's picker.

Reports embed their default layout. An existing local working copy takes precedence only when it belongs to the same embedded default. The download icon captures the current layout in a self-contained HTML report.
