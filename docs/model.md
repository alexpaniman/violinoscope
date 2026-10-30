# Time and layouts

Each occurrence of the chosen `--unit` span is one measurement, even when units overlap. Its label comes from that span, its enclosing request, then its descendants. The root is elapsed time, not CPU consumption.

## The tree

A normal violin selects **one recorded span name within its scope**. A group contains other nodes and has a small group mark. Both can have aliases; Made of shows the recorded name or the group's immediate members.

Higher selections take precedence over lower occurrences of the same name. Adding `malloc` beside `Compile` extracts malloc from Compile. Deleting that selection returns its time. Inside a group `{Compile, malloc}`, malloc selects only calls within that group's Compile domain. A root malloc selection shadows the inner one; deleting it makes the local selection count again.

Group domains come from their broader members. Broader/narrower relationships use the complete recording's name-ancestry graph; recursive names form one component. Removing Compile from `{Compile, malloc}` leaves an ordinary malloc domain. There is no remembered boundary. A different recording can establish different name relationships, so inspect imported layouts when instrumentation changes.

Allocation follows actual call occurrences, including recursion. For `A[0,100] → B[20,80] → A[40,60]`, an A→B layout gives A100, B40 and Rest of A60. Recursive re-entry belongs to the upper A. A further A selected beneath B remains visible at zero.

Sibling allocations are disjoint. Parents contain their children's allocations plus their own remainder; groups are the union of their members. For truly overlapping calls, the deepest selected occurrence wins, then latest start, earliest end and binary call-path order break ties. This is deterministic attribution, not a critical-path calculation. Unselected instrumentation cannot steal time from a selection.

Each top-level projection is an independent analysis with the same rules and no visible unit root. Copies contain the configured subtree, evaluated afresh in their destination. Grouping projections combines them into one analysis. No projection changes the main tree.

## Editing

| Action | Result |
| --- | --- |
| + → Spans | Add exact names from the scope, largest proposed share first. New nodes have no children. A group's picker uses its containing scope so broader members can be added. |
| + → Hidden | Reveal existing hidden nodes or Rest. |
| Triangle | Open or close the display; measurements stay fixed. |
| Hide | Keep the node in the calculation and lift its children visually. Reveal it from + or the connection marker; its previous collapse state returns. |
| × on a span or closed group | Delete that subtree and its exploration. |
| × on an open group / Split up | Remove the wrapper, promote its base members, discard local refiners. An existing same-name destination source is kept; independent projection roots remain separate. |
| Drag onto a sibling | Group them. Drag near a column edge to reorder. |
| Drag into another node / Move to | Reparent the subtree and recompute scope. Drop on the projection + to copy from the main tree. |
| Shift-select → Group | Lift selected branches to their common containing level and group them. Conflicting duplicate names are rejected. |
| Branch × | Delete all configured children, including hidden ones. |
| Layout's clear icon | Keep only the expanded unit root. |

Reordering, aliases, collapse and hiding do not change allocation. Hidden contributors can mark + subtly; zero-valued selections remain available to inspect or delete. Undo/redo restores exact snapshots, including what-if factors. Deleted nodes cannot pass factors to newly created nodes.

**Rest of P** is P minus all configured children, including hidden ones. Every span node has one, initially hidden. It can only be hidden or revealed; groups have none. It never claims time or highlights +.

**Not covered by spans** is a fixed virtual source: the unit interval minus all recorded proper descendant intervals. It behaves like a name selector and does not change when the layout changes.

## Async and what-if

Parent/child links alone do not tell whether a parent waits. The optional custom attribute `span.flow=async` starts a logical flow; descendants inherit it. `--flow-attr` changes the imported attribute. No recorded name is special-cased.

A flow explicitly linked with `span.link.relation=depends_on` to its direct child flows represents a dependency group. Its coverage can count inside an enclosing main phase, clipped to that occurrence. It does not establish exact blocked time. Individual child flows are independent projections, including tails beyond the unit. Nested selections cannot borrow another occurrence's containing interval.

What-if factors scale attributed main-flow intervals. Independent measurements remain unchanged, including inside mixed groups. Factors from independent analyses multiply where their eligible intervals intersect. Hidden factors still apply. This estimates latency under an assumption; it does not simulate scheduling.

Flame charts, waterfall, callers/callees and the table retain logical flow boundaries. Selecting a query scrolls the waterfall; zoom and selection keep its row list stable. Filtering datasets and folding branches still changes the list deliberately.

## Automatic breakdown and saved layouts

The duration chart also explains unexpanded recorded steps. Its recursive heuristic labels a part when its mean share reaches 10% somewhere on the axis or averages 5%. A child covering two thirds of a meaningful remainder can replace a broader label. When Other averages 15% and has room, up to two more parts averaging at least 1.5% get labels. Hover shows contributions.

The layout menu autosaves edits to the selected entry. Double-click or F2 renames it; drag its handle or use Alt+↑/↓ to reorder. Header icons copy/paste JSON; Shift-click uses files. The picture icon copies PNG including what-if labels; Shift-click downloads it. Successful copies briefly show ✓.

Portable layouts store only names, group structure, aliases and display flags. No traces, query text, exclusions or captured cuts. Missing names stay at zero. Legacy path layouts import as name trees, so repeated paths coalesce and historical path constraints are not retained; review their broader name matching. Reports embed a default; a local working copy takes precedence only for that same default. Without a supplied layout, a new report starts with only its expanded unit root.
