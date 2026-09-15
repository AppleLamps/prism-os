# Patterns: familiar loops as different algorithms

Each doc in this folder takes one loop or habit from ordinary JavaScript UI code, e.g. `findIndex` over rows or `sort` by date, and explains the different algorithm that replaces it in a program that runs every operation on every frame and can't stop early. The docs are grouped into five families by what their algorithms share.

The format comes from the repo root's [parallel-winner.md](../../../../parallel-winner.md): a title, one sentence saying what the pattern computes, and a diagram small enough to check by hand. Every doc here then has the same sections: the loop it replaces, the circuit with a builder excerpt, cost with measured sizes, when it's exact, when not to use it, and where it's used, ending with its example and test. A few docs add a section where their subject needs one: "Where it came from" in [the first active candidate, in a tree](first-active-tree.md), "What the user sees differently" in the three docs of the last family, and "Why cells keep behavior editable and learnable" in [tables that JavaScript writes](tables-javascript-writes.md).

Costs use the guide's two measures: operations, the total work of one evaluation, and layers, the longest chain of operations that must run one after another. n is the item count, k the number of steps or events, S the number of states, L the number of line slots, C the number of candidates, and K a number of DOM slots or possible results fixed while building. Each doc's test pins the sizes quoted below, and `bun test lab/ui-exploration/guide/examples/patterns` from the repo root runs every pattern's test.

## Why a chain and a tree compute the same thing

The first two families replace a loop that visits parts one at a time, i.e. a chain, with a tree that combines parts in pairs, then pairs of pairs, so the longest chain grows like log2 n instead of n. The two give the same result when the combining step gives the same result however the parts are grouped: combining a with b, and then the result with c, gives what combining a with the combination of b and c gives. E.g. "the left group's first active candidate if the left group has one, otherwise the right group's" returns the first active candidate among a, b and c in either grouping, and so does "the larger score, and the left one on a tie" for the first highest score. For events through a state machine, combining two events' tables means "the earlier event, then the later event", which any grouping of three events also means.

Whether the grouping can change a bit depends on what the combining step computes:

- Choosing a candidate never computes a new number. The step passes one candidate's values along, so every grouping returns the same bits, as long as every comparison is exact. `emitArgmax`'s comparison isn't exact for right scores between about 1e-7 and 2e-7 larger than the left score, and inside that band its tree can pick a different candidate from the loop ([the highest score, in a tree](highest-score-tree.md#when-its-exact)).
- Sums and products round in FP32, so the grouping is part of the result. With row heights 229, 167.4, 208.5 and 194.4 px, the loop's content height is 799.300048828125, while adding in pairs gives 799.2999877929688, one FP32 step lower. Integers below 2^24, and multiples of a power-of-two grid while totals stay small, add exactly in any grouping, which is when [running totals](running-totals.md) as a tree match the loop bit for bit. A spring's [matrix power](matrix-powers.md) built by the circuit differs from JavaScript's squaring in its last bits for the same reason.
- Tables of integer states or positions, combined with index reads, copy integers without rounding, so [events through a state machine](state-machine-prefix-scan.md) and [following links by doubling](pointer-jumping.md) give the same bits in any grouping.

## Choosing one candidate

Each candidate's test or score is computed in the same layers, and one small structure over those results picks one candidate: a tree when the results can be in any order, or a count when the results read 1...1 0...0.

| Pattern | The loop it replaces | Operations and layers |
| --- | --- | --- |
| [The first active candidate, in a tree](first-active-tree.md) | the first hit among overlapping click targets, e.g. index.ts's `hitTestPresented2DMode` from the topmost box down | O(n) operations in O(log n) layers: 316 operations in 31 layers at 64 candidates, against 127 in 127 for the chain |
| [The highest score, in a tree](highest-score-tree.md) | keeping the best layout so far, `if (layoutScores[layout] > layoutScores[bestLayout]) bestLayout = layout` | O(n) in O(log n): `emitArgmax` is 437 operations in 33 layers at 64 candidates, and the exact tree 500 in 39 on a 1/64 grid |
| [Count instead of search](count-instead-of-search.md) | hn.js's walk over rows until `rowTop <= pointerY && pointerY < rowTop + rowHeights[row]` | O(n) in O(1) after the row bottoms: 195 operations in 3 layers at 64 rows, against 447 in 34 for a tree |

## Combining steps

A loop that carries a value from step to step becomes a tree of combines. That works when two steps combine into a step of the same kind: two additions into a sum, two spring steps into one matrix, two events into one table, two links into a longer link.

| Pattern | The loop it replaces | Operations and layers |
| --- | --- | --- |
| [Running totals as a tree of additions](running-totals.md) | `for (...) { rowTops.push(top); top += heights[row] }` | a Brent-Kung network is about 2n operations in about 2 log2 n layers, 2,036 in 18 at 1,024 rows, against 1,023 in 1,023 for the chain |
| [Repeated steps as one matrix power](matrix-powers.md) | index.ts's `stepSpringTo`, `for (let i = 0; i < steps; i++) { v += (Fspring + Fdamper) * t; pos += v * t }` | when JavaScript writes the matrix, 14 operations in 3 layers per spring for any step count |
| [Events through a state machine, as a prefix scan](state-machine-prefix-scan.md) | `for (const event of events) state = nextButtonState(state, event)` | O(S × k log k) in O(log k): 897 operations in 10 layers at 64 events, against 129 in 65 for the loop |
| [Following links by doubling](pointer-jumping.md) | `start = nextStart[start]`, once per line slot | O(n log L) in O(log L): 342 operations in 7 layers at 63 segments and 32 line slots, against 94 in 32 for the walk |

## Per-item computations, then counts and sums

Instead of a loop that visits items in order and exits at the first match, the same computation runs on every item in the same layers, e.g. how many items come before this item, or whether the container is at least as wide as this threshold, and the results are added up.

| Pattern | The loop it replaces | Operations and layers |
| --- | --- | --- |
| [Ranks instead of sorting](ranks-instead-of-sorting.md) | `items.sort(...)` followed by a running top, and vibescript's draggable-cards swap loops | O(n²) in O(1): 4,096 operations in 3 layers at 64 items. When one card moves, O(n): 1,404 in 8 at 100 cards |
| [Threshold counts instead of floor and division](threshold-counts.md) | `clamp(1, Math.floor((containerSizeX - boxesGapX) / (boxMinSizeX + boxesGapX)), 7)`, then `Math.floor(i / cols)` and `i % cols` | K − 1 comparisons in O(1): 13 operations in 3 layers for the column count, and 458 in 4 with the row and column of 221 items |
| [Compaction into K DOM slots](compaction-into-slots.md) | `for (...) if (price >= minPrice && price < maxPrice) shownItems.push(item)`, stopping at K items | 1,000 items into 20 DOM slots: 7,824 operations in 57 layers by binary search, or 47,044 in 24 with one-hots |
| [One program per item](one-program-per-item.md) | one `for` loop over rows that mixes lines that read one row with lines that carry a value to the next row | O(p) operations at any item count, where p is the per-item work: the example's stages are 3 operations in 3 layers and 12 in 4 |

## Candidates and prepared tables

Work that a loop would redo on every frame either runs once for every candidate, e.g. every layout or every value the state could hold, and one result gets picked afterwards, or JavaScript computes it ahead of time and the program reads it.

| Pattern | The loop it replaces | Operations and layers |
| --- | --- | --- |
| [Run every candidate, then pick one](run-every-candidate.md) | building every layout and keeping the first one with the highest score, instead of hand-written `if` rules | every candidate's operations, plus O(C) in O(log C) for the pick: 114 operations in 25 layers for 3 layouts of 8 photos |
| [Speculation](speculation.md) | keyboard focus over queued key events, `for (const key of keyQueue) focusedIndex = ...` | about S times the loop's operations, in O(√k) layers: 1,000 operations in 25 layers at 64 events, against 193 in 129 for the loop |
| [Breakpoints found ahead of time](breakpoints-found-ahead-of-time.md) | laying out every chat bubble on every frame, with a greedy while loop over each message's words | 2 operations per threshold, in 3 layers: 106 operations for 45 thresholds and 16 outputs |
| [Tables that JavaScript writes](tables-javascript-writes.md) | hn.js's `while (ancestor > 0 && indents[ancestor] > pointedLevel) ancestor--`, and the spring loop over steps | 1 operation in 1 layer per index read at any table size, and 14 operations in 3 layers per spring |

## Changing the behavior to remove a dependency

Some chains don't get shorter by regrouping, because a later step reads an earlier step's result. These patterns change the app's behavior to remove the dependency, e.g. the hit test for a press reads the toasts' destinations, which come from stored state, instead of the positions where the toasts are drawn, which need the springs to run first. Each doc says what the user sees differently.

| Pattern | The loop it replaces | Operations and layers |
| --- | --- | --- |
| [Hit-test destinations instead of drawn positions](hit-test-destinations.md) | ui.md's `st.toasts.findIndex(...)`, testing `toast.top.pos`, where the toast is drawn | up to the pressed bits, 35 operations in 5 layers against destinations, against 205 in 34 against drawn positions |
| [Commit state at events](commit-at-events.md) | ui.md's `render(now)`, which steps springs to the frame's timestamp and commits state in every frame | the same program at the same size and depth, and the same evaluations, plus one table copy per frame (22 cells in the example) |
| [Read last frame's value](read-last-frame.md) | a layout loop after the animation tick that reads this frame's `st.drawerWidth.pos` | the same 144 operations, in 17 layers instead of 30 |

## Later work

The exploration found more patterns that no doc covers yet. Each one is explained in a section or a prototype:

- Water filling: grow and shrink with min and max as clamp bits over one shared level, e.g. layout-tree's widths pass at 64 children, 784 operations in 9 layers ([loops, section 6](../sections/loops.md#6-grow-and-shrink-with-min-and-max-water-filling)).
- Window slots: DOM slot k shows `firstVisibleRow + k` when the visible rows form one run, e.g. hn-thread's 48 window slots, 1,269 operations ([loops, section 8](../sections/loops.md#8-common-ui-jobs-and-their-formulations)).
- Floor division by a constant with a correction step, index-read's `emitFloorDivide`, 8 operations in 7 layers, and division by a runtime count through reciprocals read from the count's one-hot, as in codegen's life-calendar ([loops, section 4](../sections/loops.md#other-uses)).
- Other ways to find the first hit: the largest key ([loops, section 2](../sections/loops.md#circuit-way-3-the-largest-key)), earlier-hit counts `relu(hit − hitsBefore)` ([way 1](../sections/loops.md#circuit-way-1-count-the-earlier-hits)), and numeric-library's exact minimum by counting.
- A line's end as a count of "the line through segment j fits" bits, and the next-start table built from those counts ([text, idea 2](../sections/text.md#a-lines-end-is-a-count)).
- Quantizing inputs in the host, e.g. pointer coordinates to 1/64 px, so comparisons become integer bits, which nearly every pattern here relies on ([glossary](../README.md#the-program-and-the-host)).
- A masked sum over a one-hot as a read, which the compiler lowers to one gather ([indexing, way 2](../sections/indexing.md#way-2-gather-lowering-in-the-compiler), and [tricks.md](../../../../tricks.md#one-hot-indexing)).
- [Circular coordinates](../../../../tricks.md#circular-coordinates), from tricks.md.
- Training through a soft read, then running the hard tree ([indexing](../sections/indexing.md#hard-attention-as-the-limit), [lab/cascade-argmax](../../../cascade-argmax/README.md)).
- One interpreter program whose rules live in cells, so different state machines run through one compiled program ([chains](../sections/chains.md#batching-different-chains-together)).
- Sorting networks, O(n log² n) operations in O(log² n) layers ([loops, section 5](../sections/loops.md#a-sorting-network-instead)).
- Per-item constants moved from weights to inputs ([instancing](../sections/instancing.md#per-item-constants-from-weights-to-inputs)).
- Newton's method for division by a runtime value and for square roots, and polynomials for sine and cosine ([numeric-library](../../numeric-library/README.md)), which the model section's translation table lists without a pattern doc.
