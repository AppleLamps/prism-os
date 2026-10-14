# Drag knobs: direct manipulation of design numbers through one backward pass

## What it is and how to run it

This folder asks whether dragging any output edge of a compiled UI can move its design numbers as one uniform operation, with no inverse code per widget. It also asks how often a drag needs a change that crosses a decision (a grid's column count, a text's line count, the selected layout), where the gradient is 0 or misleading and search has to take over.

It lifts five design numbers of layout-tree's app shell into source cells: card padding, the grid gap, the minimum card width, the sidebar's open width, and a card title font scale. When a designer drags a card's edge, the host seeds the output gradient on that edge's wires, backpropagates to the knob cells, and takes a minimal-norm step over the knobs the designer unlocked. When the error stays above 0.5 px, a step changes a decision, or a step adds horizontal overflow, the host evaluates 256 knob candidates as instances of the same circuit and keeps the closest valid one. Flip queries answer questions like "the grid drops to 3 columns if minCardWidth reaches 248 px" from an unclamped margin next to each exact decision. The same solver runs unchanged on a copy of the repo root's candidate-gallery.ts that adds unclamped raw scores for the flip queries.

Run from the repo root:

- `bun test lab/ui-exploration/drag-knobs` runs 13 tests in about 1.5 s.
- `bun lab/ui-exploration/drag-knobs/report.ts` prints every table in this README and writes `report-results.json`. It takes about 25 s.
- `bun lab/ui-exploration/drag-knobs/demo.html` opens the demo. Drag the left, right or bottom edge of any card. Checked knobs may move. The panel shows the knob values, how the last frame was solved, and flip sentences for the dragged card's grid and title. Nobody has opened the demo in a browser yet; its logic is in `demo-model.ts`, which the tests drive headlessly, and `bun build` bundles the page. A later Chrome check opened the demo, see [Browser check](#browser-check).
- `bunx tsc -p lab/ui-exploration/drag-knobs` type-checks the folder.

numeric-ui-core.ts is unchanged and imported through `../../../src/runtime/numeric-ui-core.ts`. codegen's `codegen.ts` and `instance.ts` are imported from `../codegen/`. Until September 15, 2026 this folder held unchanged copies of them. Everything else is copied into this folder: layout-tree's tree, builder, ops, reference, compare, text tables and app shell, and the repo root's `candidate-gallery.ts` (circuit and machine only).

## What was built

- `tree.ts`, `builder.ts`, `ops.ts`, `reference.ts`, `circuit-tools.ts`, `compare.ts`, `text-table.ts`, `app-text-tables.ts`: layout-tree's layout engine with three changes.
  - A design number in the tree is an `Amount`: a plain number, which folds into biases as before, or a `Knob`, which becomes a source cell. Padding, gaps and a grid's minimum cell width enter every affine form as one extra weight on the knob's cell. A text's font scale multiplies its prepared widths, its line-count thresholds and its line height, one ReGLU each. The JS reference reads the same knob values.
  - Every exact decision `[d >= 0]` records its difference wire `d`, e.g. `inner + 1/64 - (c × minCellWidth + (c - 1) × gap)` for a grid's bit "at least c columns". That wire is the decision's unclamped margin in pixels.
  - An optional horizontal overflow count: one bit per row, and one per child of a column or wrap, that says whether the children exceed the inner width by more than 1/64 px. The JS reference computes the same count from rectangles alone.
- `app-shell.ts`: the app shell with any subset of the five knobs lifted, plus a `design.settled` cell. The sidebar's width comes from a spring. At rest, `emitSpring` returns the destination. But once a knob moves the destination, the spring becomes active, and this frame's position no longer depends on the destination, so the gradient through the spring is 0 and a drag can't move the sidebar. With `design.settled` set to 1, the layout reads the spring's destination, i.e. the layout at rest, which is what a designer edits.
- `backward.ts`: a copy of the runtime's `backpropagateReference` with a second way of treating booleans. Straight-through (the runtime's option, which the brief asked for) passes a boolean's gradient to its score unchanged. Frozen passes nothing, which gives the exact slope inside the current decision region.
- `drag-solver.ts`: the solver. A `DragProblem` names the knob cells with their ranges, the integer outputs that count as visible decisions, the violation count, the output wires edges may read, and the margin wires. From those wires the solver compiles two programs: generated JS for the forward pass (scattered back into wire order for backpropagation), and codegen's instance loop with the knobs as per-instance cells. `solveFrame` runs up to 3 projected minimal-norm steps: with `scale_k = max(|knob_k|, floor_k)`, `knob_k += error × g_k × scale_k² / Σ_j (g_j × scale_j)²`. A knob sitting at a bound, whose step would push it further out, leaves the step. When no unlocked knob is left, the frame records why: every unlocked knob has gradient 0 (`zeroGradient`), or some unlocked knob has a gradient but sits at the bound the step would push it past (`blockedAtBound`). Search has two candidate families. The brief's family is 256 points along the first step's direction, knobs = start + t × error × direction for t from -1 to 4. The second family spends half the budget on that line and half sweeping each unlocked knob across its range, then takes up to 3 gradient steps from the chosen candidate. A candidate is valid when it adds no overflow, and it replaces the current best only when it is closer by at least 0.01 px.
- `flip-query.ts`: a margin query has margin terms, the discrete results the margin controls, and the results expected after the flip. One backward pass gives the margin's gradient for every knob, and the predicted change for knob k is `-margin / gradient_k`. Each prediction is checked independently of the gradient: 256 instances scan the knob over its range toward the prediction, and bisection with the evaluator locates the first change of the results.
- `app-drag.ts`: the app shell as a DragProblem. Every rectangle edge is an output. Grid column counts, line counts, wrap line indices and the sidebar's shown bit are decisions. The overflow count is the violation count. Grid and line flip queries come from the decision records.
- `candidate-gallery.ts`, `gallery-drag.ts`: candidate-gallery as a DragProblem, with the gap, the cinema rail maximum and the 7 quality scales as knobs, and the selected layout one-hot and the hero's presence as decisions. The copy adds `rawScores`, each layout's quality bottleneck without the clamp at 1. Rival i takes over from winner w exactly when `rawScores[w] - scores[i]` crosses 0 (strictly for a rival to the right, to equality for a rival to the left, because ties go to the leftmost), whether or not either score is clamped. So that expression is the unclamped margin for the selected layout.
- `scripted-drags.ts`: seeded drags across edge categories. Each drag arrives as 6 frames whose target moves linearly toward the final delta, and each frame starts from the previous frame's knobs.
- `demo-model.ts` (all demo logic), `demo.ts`, `demo.html`, `demo.css`, `drag-knobs.test.ts`, `report.ts`.

The solver, the flip queries and the search know nothing about cards, grids or layouts. The code specific to each UI lists the knob cells and their ranges, which outputs count as decisions, and which wire counts violations: 106 lines for the app shell (`app-drag.ts`, including the grid and line flip queries) and 78 for candidate-gallery (`gallery-drag.ts`).

## Measured results

Counts come from `compileTensorProgram` on the named roots. Timings are rough: other agents share this machine. Drag statistics are deterministic (seeded drags, deterministic arithmetic); only the µs columns change between runs.

### What lifting costs

| variant | sources | operations built | live ops | layers | stored weights |
| --- | --- | --- | --- | --- | --- |
| nothing lifted (layout-tree's app shell) | 544 | 3,957 | 2,806 | 115 | 7,451 |
| cardPadding alone | 545 | 3,958 | 2,807 | 115 | 7,617 |
| gap alone | 545 | 3,957 | 2,807 | 116 | 7,609 |
| minCardWidth alone | 545 | 3,956 | 2,808 | 116 | 7,491 |
| sidebarOpenWidth alone | 545 | 3,957 | 2,806 | 116 | 7,452 |
| titleScale alone | 545 | 4,027 | 2,865 | 115 | 7,553 |
| all five knobs | 549 | 4,027 | 2,866 | 116 | 7,776 |
| all five knobs + the design.settled cell | 550 | 4,031 | 2,870 | 118 | 7,783 |
| + the overflow count as an output | 550 | 4,562 | 3,260 | 118 | 8,836 |
| drag program: every rectangle, visible decision and the overflow count | 550 | 4,562 | 3,257 | 118 | 8,829 |
| + the margins of grid, line and wrap decisions | 550 | 4,562 | 3,468 | 118 | 9,462 |
| + the margins of every recorded decision (the solver's program) | 550 | 4,562 | 3,523 | 118 | 9,621 |

With nothing lifted, the copy compiles into exactly layout-tree's numbers. A knob used as a bias costs one weight per use and almost no operations, because the affine forms that used the number already exist. For example, lifting card padding adds 166 stored weights and 1 live op. The font scale costs 59 live ops: one ReGLU per prepared width and threshold of the 14 card titles, and one per line height. The builder records 511 decisions: 284 line thresholds, 135 overflow checks, 70 water-fill clamps, 9 wrap fits, 8 grid bits and 5 in the app part (hit test and breakpoint). Exposing every margin as an output adds 266 live ops. The solver's instance plan has 2,996 per-instance rows and 527 shared rows.

### The lifted circuit against the JS reference

| knob settings | positions and sizes compared | max drift px | discrete results compared | discrete mismatches | overflow count mismatches | sidebar width mismatches |
| --- | --- | --- | --- | --- | --- | --- |
| 300 | 223,500 | 0.0009375 | 27,600 | 0 | 0 | 0 |

Knobs were uniform in their declared ranges (padding and gap 0..48 px, minimum card width and sidebar width 120..480 px, title scale 0.5..1.5), with viewport widths 320..2400 px. The generated forward pass, the gradients through it, and the instance candidates match the reference evaluator bit for bit on every requested wire (tested).

### 500 drags on the app shell

Categories, 83 or 84 drags each: a card's right edge, left edge or bottom edge, a card title's bottom edge, the sidebar's right edge, and the second section's top edge. Each drag starts from the authored knobs or, with probability 1/2, from random knobs in the middle 60% of each range. The viewport width is 700..1900 px. The final delta is ±4..96 px over 6 frames. Each drag unlocks every knob or, with probability 1/2, one or two random knobs (261 and 239 drags). A frame is moving when its target is more than 0.5 px from the edge at the frame's start (2,999 of 3,000 frames).

Strategies:

- A: the brief. Straight-through booleans, search along the gradient line, search whenever a step changes a visible decision.
- B: frozen booleans, otherwise as A.
- C: frozen booleans, the gradient line plus knob sweeps and polish, search whenever a step changes a visible decision.
- D: as C, but search only when the error stays above 0.5 px or a step adds overflow.

| strategy | moving frames | solved by 1 gradient step | solved within 3 steps | gradient 0 for every unlocked knob at the start | every unlocked knob with a gradient is at its range bound at the start | a gradient step changed a visible decision | searched | solved after search | unsolved | frames whose result flips a decision | mean µs | median µs | p90 µs | mean µs, searched / not searched frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 2,999 | 63.3% | 65.0% | 24.0% | 2.7% | 24.9% | 55.0% | 14.4% | 40.6% | 16.4% | 407 | 70 | 1,248 | 680 / 73 |
| B | 2,999 | 63.6% | 64.9% | 24.6% | 2.9% | 24.3% | 55.0% | 14.3% | 40.7% | 16.4% | 366 | 56 | 1,188 | 618 / 58 |
| C | 2,999 | 63.6% | 64.7% | 24.6% | 2.8% | 24.2% | 55.4% | 18.0% | 37.4% | 18.1% | 668 | 1,084 | 1,208 | 1,162 / 57 |
| D | 2,999 | 63.6% | 64.7% | 24.6% | 2.8% | 24.2% | 41.1% | 3.7% | 37.4% | 18.1% | 512 | 61 | 1,198 | 1,168 / 55 |

"Solved by 1 gradient step" counts frames where the first step reached 0.5 px, even if a strategy then searched because a decision changed. "Solved after search" counts frames that searched and ended within 0.5 px, including frames where the search kept the gradient result. The two gradient columns count frames whose first gradient step found no knob to move: either every unlocked knob has gradient 0, or every unlocked knob with a nonzero gradient sits at the range bound the step would push it past, e.g. gap = 0 while the edge needs a smaller gap.

By category, strategies A and D:

| category | moving frames | solved by 1 step, A / D | within 3 steps, D | gradient 0 for every unlocked knob at the start, D | every unlocked knob with a gradient at its range bound, D | searched, A / D | unsolved, A / D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| card right edge | 504 | 32.7% / 37.5% | 37.5% | 56.0% | 1.0% | 84.1% / 70.4% | 71.2% / 65.9% |
| card left edge | 504 | 52.6% / 54.8% | 55.2% | 31.0% | 4.4% | 73.6% / 52.4% | 55.4% / 50.2% |
| card bottom edge | 497 | 67.7% / 66.0% | 68.2% | 13.3% | 7.2% | 44.4% / 31.8% | 29.9% / 28.0% |
| card title bottom edge | 498 | 76.9% / 74.7% | 76.1% | 12.0% | 1.0% | 34.2% / 23.9% | 20.9% / 17.5% |
| sidebar right edge | 498 | 72.1% / 72.1% | 72.1% | 27.7% | 0.0% | 60.4% / 46.8% | 46.2% / 46.4% |
| second section top edge | 498 | 78.1% / 76.7% | 79.3% | 7.2% | 3.4% | 32.5% / 20.7% | 19.5% / 15.9% |

By which knobs were unlocked:

| unlocked | moving frames | solved by 1 step, A / D | within 3 steps, A / D | gradient 0 for every unlocked knob at the start, A / D | every unlocked knob with a gradient at its range bound, A / D | searched, A / D | unsolved, A / D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| every knob | 1,566 | 82.1% / 82.5% | 84.7% / 84.0% | 7.3% / 7.3% | 0.2% / 0.2% | 42.8% / 24.2% | 23.2% / 18.4% |
| one or two random knobs | 1,433 | 42.7% / 42.8% | 43.5% / 43.5% | 42.3% / 43.5% | 5.5% / 5.7% | 68.2% / 59.5% | 59.6% / 58.1% |

Per drag:

| strategy | last frame within 0.5 px | every frame within 0.5 px | drags that flip a decision | what search picked, over searched frames |
| --- | --- | --- | --- | --- |
| A | 51.0% | 46.6% | 48.2% | start 1,053, gradient result 419, line 177 |
| B | 51.0% | 46.6% | 48.2% | start 1,057, gradient result 450, line 142 |
| C | 55.0% | 50.0% | 51.0% | start 955, gradient result 461, line 92, sweep 92, polished 61 |
| D | 55.0% | 50.0% | 51.0% | start 955, gradient result 39, line 86, sweep 91, polished 61 |

Decisions that flipped in accepted results (strategy D):

| decision kind | flips | in the dragged card or its grid |
| --- | --- | --- |
| text line count | 1,073 | 48 |
| grid column count | 74 | 23 |
| wrap line index (the tag row) | 62 | 0 |

### Why frames stay unsolved

Every unsolved frame of strategy D was checked with a heavier search from the same starting knobs: 4,096 random candidates over the unlocked knobs, keeping only candidates with no more overflow than the frame's start, then a full solver frame from the closest one. That includes the frames whose gradient step reached the target but added overflow.

| category | moving frames | solved by the solver | unsolved | gradient 0 for every unlocked knob at the start | every unlocked knob with a gradient at its range bound | the gradient reached the target but added overflow | ... of which the heavier search reaches 0.5 px | the heavier search reaches 0.5 px | no candidate found | solved among frames something reaches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| card right edge | 504 | 172 | 332 | 282 | 5 | 26 | 16 | 30 | 302 | 85.1% |
| card left edge | 504 | 251 | 253 | 156 | 22 | 29 | 11 | 35 | 218 | 87.8% |
| card bottom edge | 497 | 358 | 139 | 65 | 34 | 0 | 0 | 17 | 122 | 95.5% |
| card title bottom edge | 498 | 411 | 87 | 59 | 4 | 0 | 0 | 16 | 71 | 96.3% |
| sidebar right edge | 498 | 267 | 231 | 138 | 0 | 92 | 1 | 1 | 230 | 99.6% |
| second section top edge | 498 | 419 | 79 | 36 | 15 | 0 | 0 | 15 | 64 | 96.5% |
| every category | 2,999 | 1,878 | 1,121 | 736 | 80 | 147 | 28 | 114 | 1,007 | 94.3% |

The last column is solved / (solved + reached by the heavier search). "No candidate found" is not a proof of unreachability, but four causes explain most of those frames:

- **Pinned edges.** The right edge of a card in the last column is the grid's right edge, i.e. the viewport width minus the main column's padding, so every knob's gradient is 0 there, and no knob value moves that edge further right. Likewise, the left edge of a card in the first column only moves with the sidebar.
- **Locked knobs that don't touch the edge.** E.g. only titleScale is unlocked while dragging a card's right edge.
- **Knobs at their range bounds.** In 80 unsolved frames, some unlocked knob could move the edge, but every such knob sat at the bound the step would push it past. The gap sat at 0 in 46 of the 85 moving frames like this; the others had titleScale, cardPadding or the gap at one end of its range. None was a drag's first frame: an earlier frame of the same drag had pushed the knob to its bound.
- **The overflow wall.** The sidebar's nav rows are 196 px wide with 12 px of padding, so the solver refuses any sidebar width below 208 px. All 92 of the sidebar's frames whose gradient step added overflow target a width below 208 px, and the heavier search reached only 1 of them without raising the overflow count. Card edges are different: there the gradient's direction ran into overflow, but the heavier search reached 27 of those 55 frames without raising the overflow count.

Two examples the heavier search reached and the solver missed. In drag 30, a card's right edge with every knob unlocked, the solver ended 9.67 px away and random search plus polish ended 0.22 px away. In drag 271, a card's left edge with every knob unlocked, the gradient step added overflow; the solver's frames 1 to 4 ended 7.86 to 43.78 px away, and random search plus polish ended within 0.4 px of each target without adding overflow. The solver's sweeps move one knob at a time, while random search moves every unlocked knob at once; I didn't isolate which knobs these targets needed.

### Gradients against finite differences

At each drag's start, the dragged edge's gradient for every knob was compared with central differences at three step sizes: 0.01, 1 and 8 px for pixel knobs, and 0.0001, 0.01 and 0.08 for the title scale. They agree when they differ by at most 0.01 + 0.1% plus the FP32 resolution of the two edge values divided by the span. For each disagreement, the report checks whether a visible decision flipped within ± the step, or only a hidden one (a water-fill clamp, an overflow bit, the breakpoint).

| UI, booleans, step | pairs | agree | disagree: a visible decision flips | disagree: only a hidden decision flips | disagree: no recorded decision flips | largest disagreement with no recorded flip |
| --- | --- | --- | --- | --- | --- | --- |
| app shell, straight-through, 0.01 px | 2,500 | 2,500 | 0 | 0 | 0 | - |
| app shell, straight-through, 1 px | 2,500 | 2,404 | 59 | 0 | 37 | card left edge vs minCardWidth: gradient -0.03125, difference 0 |
| app shell, straight-through, 8 px | 2,500 | 2,118 | 357 | 1 | 24 | same |
| app shell, frozen, 0.01 px | 2,500 | 2,500 | 0 | 0 | 0 | - |
| app shell, frozen, 1 px | 2,500 | 2,444 | 56 | 0 | 0 | - |
| app shell, frozen, 8 px | 2,500 | 2,160 | 340 | 0 | 0 | - |
| candidate-gallery, straight-through, small | 2,250 | 1,658 | 0 | 0 | 592 | thumbnail left edge vs cinemaHeroWidthScale: gradient 692,700, difference 0 |
| candidate-gallery, straight-through, medium | 2,250 | 1,649 | 22 | 0 | 579 | same |
| candidate-gallery, straight-through, large | 2,250 | 1,622 | 135 | 0 | 493 | same |
| candidate-gallery, frozen, small | 2,250 | 2,250 | 0 | 0 | 0 | - |
| candidate-gallery, frozen, medium | 2,250 | 2,229 | 21 | 0 | 0 | - |
| candidate-gallery, frozen, large | 2,250 | 2,119 | 129 | 0 | 2 | hero right edge vs cinemaRailMaximum: gradient 0, difference -0.3775 |

With frozen booleans, every disagreement on the app shell coincided with a visible decision flipping inside the step. The two exceptions on candidate-gallery cross a ReLU corner that isn't a recorded decision: the rail's width is `min(railMaximum, 0.28 × viewportWidth)`. The frozen gradient of minCardWidth on the dragged edge is 0 at 499 of 500 drag starts, because that knob only feeds column-count decisions.

The two ways of treating booleans differ for two reasons:

- **candidate-gallery.** `emitArgmax` compares scores with `boolean(0.5 + 0.5 × (left - right))`, whose score has slope 0.5 everywhere. Straight-through passes half of every score difference into the selection one-hot. From there it reaches every layout's geometry and quality scales, e.g. a slope of 692,700 px per unit of cinemaHeroWidthScale on a thumbnail's left edge that doesn't move at all. The modes differ on the gap's gradient at 174 of 250 drag starts.
- **The app shell.** layout's comparison `relu(256 d + 0.5) - relu(256 d - 0.5)` saturates, so straight-through passes nothing except within 1/512 px of a threshold. But it feeds ±256× gradients into both ReLUs of every saturated comparison. Those large contributions cancel inexactly in FP32 and leave residues such as -1/64 and -1/32 on gap, minCardWidth and sidebarOpenWidth (the modes differ at 61, 32 and 61 of 500 drag starts).

### Flip queries

App shell, at 100 drag start states, for the dragged card's grid (the next column count up and down) and its title (the nearest threshold on each side), for all 5 knobs. Answering 258 queries with scans took 717 ms.

| query | answers (query × knob) | gradient 0 | ... of which the scan still finds a flip | predicted change leaves the knob's range | ... of which the scan still finds a flip | predicted inside the range | holds just past the prediction | the scan's first flip matches the prediction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grid column count | 805 | 322 | 0 | 180 | 0 | 303 | 303 | 303 |
| card title line count | 485 | 106 | 16 | 375 | 0 | 4 | 1 | 1 |

"Matches" means within 0.001 px plus 0.01% of the change for pixel knobs. Examples that held:

- recent.grid drops to 4 columns if gap reaches 17 px (now 12; the scan finds 17)
- recent.grid drops to 4 columns if sidebarOpenWidth reaches 240 px (now 220; the scan finds 240)
- recent.grid rises to 2 columns if minCardWidth reaches 266.9 px (now 396.9; the scan finds 266.9)
- card2.title wraps to 2 lines if titleScale reaches 1.465 (now 0.9962; the scan finds 1.465)
- at 1280×820 with authored knobs, recent.grid drops to 3 columns if minCardWidth reaches 248.0039 px or sidebarOpenWidth reaches 332.0156 px; the test checks that both predictions hold and that the minCardWidth prediction matches the scan within 0.001 px

A grid bit `inner + 1/64 - (c × minCellWidth + (c - 1) × gap)` is linear in the gap, the minimum cell width and the sidebar width, so each prediction inside the range is exact. Card padding and the title scale never reach a grid bit, hence the 322 zero gradients. Line counts are different. Card titles sit far from their nearest thresholds, so 375 of 485 predictions leave the range. The 3 sidebar predictions inside the range missed, because the grid's column count flips first and the card gets wider instead of narrower. minCardWidth has gradient 0 on every title margin, yet in 16 answers the scan finds a line count flip, through a column count change.

candidate-gallery, selected layout, at every 9th of the 1,377 scanned viewports (153 viewports, 2 rivals × 9 knobs each):

| viewports | answers | gradient 0 | ... of which the scan still finds a flip | predicted change leaves the range | ... of which the scan still finds a flip | predicted inside the range | holds (the expected rival takes over) | the scan's first flip matches the prediction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tied top score | 810 | 550 | 165 | 68 | 26 | 192 | 72 | 132 |
| no tie | 1,944 | 1,284 | 554 | 129 | 6 | 531 | 274 | 273 |

Ties are common: 405 of the 1,377 viewports have a tied top clamped score. At all 405, the clamped margin between the winner and the runner-up has gradient 0 for every knob, while the unclamped margin has a nonzero gradient for some knob. At a tie, the unclamped margin predicts the knob value where the current winner stops winning. That matched the scan in 132 of 192 answers inside the range. But when both rivals are clamped at 1, the leftmost rival takes over, so a query about the other rival "matches" without "holding" (72 held). Examples: "Story takes over from Contact if gap reaches 20 (the scan finds 20)"; "Cinema takes over from Contact if contactCellScale reaches 0.00329", where the scan finds Story taking over at 0.004124 first. Many knobs have gradient 0 because their quality term is not the active minimum of the bottleneck. Such a knob can still flip the layout once its term becomes the minimum: 554 of 1,284 zero-gradient answers at untied viewports.

### candidate-gallery drags

Program sizes: the machine's roots are 417 live ops / 60 layers / 848 weights. Adding the 3 raw scores costs 21 live ops. The drag program (hero, thumbnails, selection, clamped and raw scores) is 157 live ops / 27 layers.

250 drags × 6 frames over 5 categories, viewports 640..1920 × 480..1100, authored knobs. 128 drags unlock every knob, 50 only the gap and rail maximum, and 72 a random subset of one or two knobs.

| strategy | moving frames | solved by 1 gradient step | within 3 steps | gradient 0 for every unlocked knob at the start | every unlocked knob with a gradient at its range bound | searched | solved after search | unsolved | mean µs | median µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A (straight-through) | 1,500 | 16.5% | 19.3% | 15.6% | 6.9% | 81.5% | 5.8% | 75.7% | 92 | 139 |
| B (frozen, line) | 1,500 | 37.6% | 38.1% | 28.9% | 15.5% | 62.9% | 1.2% | 61.7% | 30 | 3 |
| C | 1,500 | 38.2% | 38.7% | 28.9% | 15.7% | 62.3% | 1.7% | 60.7% | 83 | 120 |
| D | 1,500 | 38.2% | 38.7% | 28.9% | 15.7% | 61.3% | 0.6% | 60.7% | 80 | 119 |

| subset, strategy | solved by 1 step | gradient 0 for every unlocked knob at the start | every unlocked knob with a gradient at its range bound | unsolved |
| --- | --- | --- | --- | --- |
| every knob, A / D | 18.1% / 49.0% | 0.0% / 11.8% | 6.5% / 17.7% | 72.1% / 49.5% |
| gap and rail maximum only, A / D | 27.0% / 45.7% | 0.0% / 4.0% | 11.3% / 24.0% | 63.3% / 52.7% |
| one or two random knobs, A / D | 6.5% / 13.9% | 54.2% / 76.4% | 4.6% / 6.3% | 90.5% / 86.1% |

By category (D): the hero's right edge was solved by 1 step in 60.0% of frames, the thumbnail's left edge in 55.0%, its right edge in 36.3%, the hero's bottom edge in 21.3% and the thumbnail's bottom edge in 18.3%. Bottom edges have little room: in Cinema the hero's bottom is `viewportHeight - gap`, and in Contact there's no hero. Of the 910 unsolved frames of D, the heavier search reached 61, so D solved 90.6% of the frames something reaches. Strategy A reports fewer frames with gradient 0 for every unlocked knob (15.6% against 28.9%), because its phantom gradients are nonzero where the true slope is 0. Every gallery frame of D that was blocked at a range bound had the gap at 0 (186 frames) or 64 (49 frames), pushed there by an earlier frame of the same drag.

### Timing (rough, warm unless noted)

| forward pass, generated JS | forward pass, reference evaluator | backward pass, frozen booleans | backward pass, straight-through | 256 candidates as instances | 4,096 candidates | building the solver's programs | first 256-candidate search after building |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 µs | 132 µs | 10 µs | 14 µs | 456 µs | 7.4 ms | 9 ms | 28 ms |

Over the 500 drags, a frame that doesn't search costs about 55 µs on average with frozen booleans (strategies B to D). A frame that evaluates 256 candidates costs about 1.2 ms (1,162 µs on average for C, 1,168 µs for D), so the search costs the same in both strategies. The medians hide this. Strategies A, B and D have medians of 56..70 µs because fewer than half of their frames evaluate candidates: D searches on 41% of frames, and A and B search on 55%, but when the gradient is 0 their line family has no candidates, so many of those searches cost almost nothing (searched frames average 680 and 618 µs). Strategy C's median is 1,084 µs only because more than half of its frames evaluate candidates. The mean is the fairer comparison: 668 µs for C against 512 µs for D, about 1.3×. The generated forward pass needs several hundred calls to reach its warm speed; its first calls take about 270 µs.

## What this shows about how far the approach goes

### What fit well

- Direct manipulation is uniform. One `DragProblem` per UI (knob cells, decision outputs, a violation count) drove both the app shell and candidate-gallery through the same backward pass, search and flip queries, with no inverse code per widget. The designer's command "this edge should be here" becomes knob changes the same way for a card's bottom edge, a sidebar's edge or a hero's edge.
- Lifting design numbers into cells is cheap. All five knobs cost 60 live ops (2.1%) and 1 layer. Padding, gap and minimum cell width cost one weight per use and 1..2 live ops, because the affine forms that used the numbers already exist. The lifted circuit matched the float64 reference at 300 random knob settings with 0 of 27,600 discrete mismatches.
- Inside a decision region, the frozen-boolean gradient is the true slope. Every disagreement with finite differences on the app shell coincided with a visible decision flipping inside the step. So gradient steps are exact where the layout is linear: 63.6% of moving frames were solved by the first step, and 82.5% when every knob was unlocked.
- Flip queries from margins are exact for linear decisions. 303 of 303 in-range grid column-count predictions held and matched the scan, e.g. "recent.grid drops to 4 columns if sidebarOpenWidth reaches 240 px". The builder's own difference wires were the margins; nothing per widget was written.
- Search as instances is cheap and exact: 256 knob candidates in about 0.5 ms, bit-identical to the reference evaluator. Most frames the solver couldn't solve were targets that a 16× larger random search couldn't reach either (1,007 of 1,121 on the app shell).
- Validity as a circuit output worked as a guard. The overflow count stopped 147 app shell frames whose gradient step reached the target by squeezing content out of its container, e.g. the sidebar below its nav rows. For the sidebar, that guard marks a real limit: the heavier search reached only 1 of those 92 frames without adding overflow. For card edges it doesn't: the heavier search reached 27 of 55 such frames without adding overflow, so a valid solution existed that neither the gradient line nor the one-knob sweeps found.

### What got awkward

- Many drags have nothing to move. 24.6% of moving app shell frames started with gradient 0 for every unlocked knob, and 43.5% when only one or two knobs were unlocked, e.g. the right edge of a card in the last column, which only the viewport moves. Another 2.8% (5.7% with one or two knobs unlocked) had knobs that could move the edge but sat at their range bounds, e.g. gap = 0 while the edge needed a smaller gap. On candidate-gallery the figures were 28.9% and 15.7%. A solver can't tell "blocked by a decision" from "unreachable" without a search, so these frames all paid for one.
- Decisions flip everywhere, not near the dragged edge. 24.2% of moving app shell frames had a gradient step that changed some visible decision. Of 1,073 line-count flips in accepted results, 48 were in the dragged card. The rest were in texts the designer didn't touch, e.g. other cards' captions rewrapping because padding or gap changed for every card. Searching whenever a gradient step changes any visible decision (strategy C) instead of only on error or overflow (D) searched 55.4% of frames instead of 41.1%, with the same 37.4% unsolved. The mean frame time rose about 1.3× (512 to 668 µs). The median jumped from 61 µs to 1,084 µs, but only because more than half of C's frames search. The brief's strategy A uses the same rule as C and has a median of 70 µs, because its line family has no candidates when the gradient is 0.
- Straight-through booleans are only right where a boolean's score saturates. candidate-gallery's argmax comparison doesn't saturate, so straight-through leaks phantom slopes into 592 of 2,250 knob and drag pairs. With the brief's straight-through solver, 16.5% of gallery frames were solved in one step, against 38.2% with frozen booleans. On the app shell, straight-through left FP32 residues of up to 1/32 where two ±256× paths cancel. Frozen booleans fixed both. generative-fields measured a straight-through slope of 173 against a true slope of 120, which may be the same leak through non-saturating booleans; I didn't check its circuit.
- Knobs behind a decision or a `min()` have gradient 0 until a different branch takes over, e.g. minCardWidth on any card edge (0 at 499 of 500 drag starts), or a quality scale whose term isn't the bottleneck's minimum (554 zero-gradient gallery answers still flip). Search along the gradient line can never move such a knob. Sweeping each knob across its range helped (drags whose last frame reached the target rose from 51.0% to 55.0%). But one-knob sweeps missed targets that random candidates moving every unlocked knob at once did reach: the heavier random search reached 114 more app shell frames.
- Line counts are far from any knob. 375 of 485 title line-count predictions left the knob's range, and the few inside the range were overtaken by a column count flip.
- Springs integrate state across frames, so this frame's position depends on a knob-driven destination only through one step's worth of motion. Dragging the sidebar needed a `design.settled` cell (4 live ops, 2 layers) that reads the destination.
- A flip query about a rival layout predicts when the winner stops beating that rival, not that the rival wins. At ties the leftmost rival takes over first (132 predictions matched the first flip, 72 took over to the expected rival).
- The generated forward program only computes declared outputs. The first version of the flip queries read margins that weren't outputs and silently got 0. The solver now throws when a query reads a wire it didn't compile.

### What stayed outside the circuit

- The solver loop: the minimal-norm step, clamping to bounds, generating candidates, and picking the closest valid candidate run in JS over circuit outputs.
- The backward pass is an interpreter over the built operation stream (10 µs here), not a compiled program of layer transposes. It never ran on the instance axis, so every candidate's gradient would need its own backward pass.
- Choosing which numbers are knobs and their ranges, which outputs are decisions, and what counts as a violation. Also the decision to read a spring's destination at design time.
- Measuring text at a new font size. The title scale is a linear model of measurement (prepared widths × scale), and the demo's DOM text at a scaled font may break lines differently; this wasn't checked in a browser.
- Hit-testing card edges and turning pointer deltas into targets (`demo-model.ts`).

## How it connects to the talk

The talk pairs homogeneity with a high-level way of directing: once everything is made of the same small units, one command can steer all of them. Here every widget is affine, ReGLU and boolean operations over one source table, so "move this edge to here" is a single backward pass through the whole program, the way one loss directs every weight of a network. Nothing in the solver knows what a card, a grid or a layout is.

The granularity gap shows up as decisions. A designer thinks "make the cards wider", but in the circuit a wider card often means "one fewer column". Fewer columns only exist as a comparison bit, whose slope is 0 everywhere, so the smooth part of the command stops at the region's edge and search has to take over. Search is cheap because the same program runs over many candidates as instances, which is the same smaller-unit move as a shader running per pixel.

Emergent behavior appears in the population of drags. Changing card padding rewraps captions in cards nobody touched, about a quarter of steps cross some decision, and most failed drags ask for something that neither the solver nor a 16× larger random search reaches. The talk's warning about premature compression applies directly: a design number folded into weights can't be dragged at all, and lifting all five costs 60 operations.

## Open questions and next steps

- A compiled backward program: each layer's transpose as a sparse matmul, so gradients run on the GPU and over the instance axis, one gradient per candidate.
- Better search families: random or low-discrepancy samples over all unlocked knobs instead of one-knob sweeps (the heavier search reached 114 more frames, 28 of them frames whose gradient step added overflow), or picking the candidate whose decision signature is closest, then polishing.
- Decision locks: let the designer say "keep 4 columns" and turn the grid's margin into a constraint on the step, instead of accepting whatever flips. Margins already exist for every decision.
- A reachability hint during a drag: sweep the unlocked knobs as instances and show how far the edge can go before starting, so an unreachable target reads as a wall instead of a stuck drag.
- Make emitArgmax's comparison saturate like layout's comparison, and measure what that costs. Straight-through would then equal frozen, and learned rules could keep using straight-through.
- Check the linear font-scale model against real browser line breaks at scaled font sizes.
- Run the same machinery on HandwiredOS through [notation](https://github.com/chenglou/handwired/tree/exploration-2026-09/lab/ui-exploration/notation)'s 19 constant cells (title height, button size, dock gaps, spring stiffness), where some knobs feed springs and hit tests instead of layout.

## Browser check

2026-09-13, Chrome, in a hidden tab with a 1,160 by 853 CSS px viewport, served with `bun lab/ui-exploration/drag-knobs/demo.html`. The hidden tab didn't render frames on its own, so a console script replaced `requestAnimationFrame` with a Worker timer every 16 ms.

- Loads, no console errors. At this viewport the grid has 3 columns, and the panel shows the five knobs at their authored values.
- Hovering a card's right edge with the real mouse sets the `col-resize` cursor, and the orange marker is centered on the edge (from 449 to 453 px for an edge at 451 px).
- A real drag of the right edge of "Harbor at dawn" 80 px to the left: "search: 1 gradient step, searched (picked sweep), error -0.33 px, 26900 µs". The grid went from 3 to 4 columns, gap from 12 to 4.0 px and sidebarOpenWidth from 220 to 208 px. The panel listed 4 flip sentences, e.g. "recent.grid drops to 3 columns if gap reaches 13.3 px".
- Real clicks unchecked gap and sidebarOpenWidth. A real drag of the bottom edge of "Quarterly notes" 60 px down then moved only unlocked knobs: cardPadding to 29.5 px, and titleScale to its maximum of 1.5. The panel said "unsolved: 3 gradient steps, searched (picked line), error 5.08 px, 6800 µs", and the card's bottom edge reached 492.9 px against a target of 498 px.
- Reset knobs restored all five values and kept the two locks.
- Scripted: 12 pointer moves widening "Harbor at dawn" by 10 px each, with gap and sidebarOpenWidth still locked. No unlocked knob changes a card's width while the column count stays the same, so every move reported 0 gradient steps. The search kept the starting knobs while the error grew to 70 px, then at +80 px picked a sweep that dropped the grid to 2 columns, with the edge at 684 px against a target of 611 px (error -73.33 px). Each move took 6.7 to 10.9 ms. After the release, minCardWidth was 295.7 px, and no flip sentence reported a scan that disagreed with its prediction.
- Scripted: a `wheel` event on the stage scrolled the main area by its whole 66 px and back. Wheel ticks from the automation tool produced no frame in the hidden tab.
- Small problem: a flip sentence reads "recent.grid drops to 1 columns if minCardWidth reaches 448.0 px".
- GIF: `~/Downloads/ui-exploration-drag-knobs-demo.gif`, which isn't in the repo (12 frames). No fixes.
