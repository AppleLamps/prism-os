# Lab experiments, read for how UI gets written in circuits

Status, September 15, 2026: written in phase 1, before the round 2 prototypes. Later measurements are in the [exploration README's capability map](../README.md#capability-map), and the current runtime's contracts and costs in the repo root's [execution-model.md](../../../execution-model.md). What this note says about IndirectOS describes window-manager.ts before September 15, 2026, when its springs, hit tests, Photos clicks and window content sizes changed ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)).

This note covers `lab/trace-compiler`, `lab/event-window`, `lab/generative-fields`, `lab/reusable-layout` (text and layout files), `lab/data-adapter`, and `lab/gather-lowering`, read only for what they show about writing and executing UI. Training, gradient studies, and learned interpreters are ignored. Nothing under `exp/` or `lab/briefs/` was read.

Line numbers in `numeric-ui-core.ts` refer to commit c3d8e54 (September 5, 2026); on September 14, 2026 the file grew from 1,653 to 3,158 lines.

I also ran the repo's report scripts and three scratch scripts. The scratch scripts are session scratch files (scratch folder `phase1/lab-ui/`, not in the repo):

- `lab-circuit-sizes.ts` prints the current size of each lab circuit next to IndirectOS.
- `text-wrap-circuit.ts` builds greedy word wrapping over prepared word widths three ways and checks every variant against a JS reference.
- `event-unroll.ts` inlines the event-window step once per queued pointer event and checks the result against stepping the machine once per event.

All sizes below were measured on this checkout unless marked as a July number from a README. "Layers" means compiled tensor layers (operations at the same dependency depth), "weights" means stored sparse weights in the compiled program, and all timings are single-threaded CPU JavaScript.

## 1. UI computations the experiments already expressed in circuits

### Current sizes

| Circuit | Sources | Operations (affine / reglu / boolean) | Layers | Stored weights | Widest layer |
| --- | ---: | --- | ---: | ---: | ---: |
| event-window, 4 rectangles, one press record | 55 | 480 (230 / 244 / 6) | 52 | 883 | 44 |
| generative-fields flow layout, 16 slots | 78 | 8,421 (4,003 / 4,082 / 336) | 201 | 13,452 | 465 |
| reusable-layout width rule, one item | 129 | 133 (13 / 120 / 0) | 5 | 349 | 96 |
| data-adapter, 8 tasks over 12 rows | 76 | 200 (74 / 126 / 0) | 14 | 239 | 36 |
| photo-gallery (root, standalone), for scale | 82 | 2,771 (1,448 / 1,287 / 36) | 91 | 5,574 | 98 |
| window-manager IndirectOS (root), for scale | 201 | 6,146 (3,189 / 2,893 / 64) | 192 | 11,598 | 123 |

The READMEs quote July sizes that are now smaller than reality. The event-window README says 502 operations and depth 38, and the flow layout README says 147 layers. The September correctness changes made min, max, and select keep their FP32 rounding points (`roundAffine`, `Circuit.select` at `numeric-ui-core.ts:182-190`), so fewer affine operations get merged into their consumers. That raised event-window from 38 to 52 layers and the flow layout from 147 to 201 layers. Depth is the cost that moved.

Trace compiler slices of chenglou.github.io's photo gallery, from `bun lab/trace-compiler/report.ts` (all verified with zero circuit mismatches, zero boolean atoms):

| Slice | Operations | Layers | Stored weights | What it computes |
| --- | ---: | ---: | ---: | --- |
| clamp | 60 | 31 | 84 | `v > max ? max : v < min ? min : v` |
| colsBoxMaxSizeXF | 524 | 91 | 700 | responsive column count and box width from viewport width |
| springStep | 14 | 8 | 24 | one 4 ms spring step |
| hitTest1DMode | 117 | 32 | 158 | left/right click regions in the lightbox, nullable result |
| 2D grid layout, specialized for 1..7 columns | 24,894 | 600 | 38,810 | sizes and positions for 221 photos |
| 1D lightbox layout with masked loops | 21,213 | 1,580 | 31,290 | positions for 221 photos around the focused one |
| occlusion culling bits | 25,416 | 32 | 34,477 | one visibility bit per photo |
| scroll compensation | 222 | 2 | 444 | `y.pos += adjustedScrollTop - currentScrollY` for 221 photos |

Synthetic gauntlet functions from the same report: responsive column count 443 operations / 51 layers, gap distribution 82 / 40, clamped panel position 124 / 60, cyclic index wrap 213 / 29, spring step with settle and snap 79 / 43, aspect-ratio sizing 118 / 58, pointer-in-box hit test 113 / 31, hover magnet 13 / 7.

### What each experiment expressed

**Hit testing.** event-window computes, for each rectangle, the minimum of four edge distances (`emitIntervalDistance`, `lab/event-window/circuit.ts:547-554`), clamps it to 0..1, and rounds it into a bit with the boolean atom (`circuit.ts:198-203`). The trace compiler lowers `x <= pointerX && pointerX < x + width && ...` with four exact sign cascades and bit products (the gauntlet `hitTestBox`, 113 operations, 31 layers). The occlusion slice is the same shape run for 221 photos: about 115 operations per photo, and only 32 layers, because the photos are independent.

**Overlap priority.** A press on overlapping rectangles picks maximized rectangles first, then the lowest index. The eight candidates (hit AND maximized, then hit AND not maximized) go through `emitFirstActive` (`circuit.ts:215-236`, `numeric-ui-core.ts:1316-1366`), a tree that routes one unit of mass to the first active candidate in log depth.

**Event-clocked latches.** Every piece of press state is written with `select(down, kept, fresh)` (`latchOnDown`, `circuit.ts:267-284`): the press position, the hit rectangle as a one-hot, the grab point, and three snapshot bits taken at press time (on title bar, already focused, maximized). The drag-begin latch is set by the move that crosses the slop distance and cleared by down and up (`circuit.ts:288-302`). Stored rectangle positions change only at release (`circuit.ts:350-388`). The displayed drag position is `grab + pointer - press`, clamped to the viewport (`circuit.ts:319-344`), so nothing integrates per frame.

**Behavior as data.** Four relation cells (drag from title, drag from body, click toggles from title, click toggles from body) are multiplied against the pressed region bit (`circuit.ts:305-315`). Thresholds sit in boundary cells at the center of the integer band they quantize, e.g. slop 4 becomes boundary 4.5 (`circuit.ts:577-608`). All 16 relation settings run through the same compiled circuit with zero divergence from the TypeScript oracle.

**Arithmetic toggle.** Maximize flips with `flipped = maximized + toggle * (1 - 2 * maximized)` (`circuit.ts:368-373`), an exclusive-or written as affine plus one product.

**History as a shift register.** On each press the live record shifts into an archive of K-1 records with one select per cell (`circuit.ts:430-452`). The July measurement was +36 operations and +60 weights per record, with constant depth.

**Flow layout with self-checking.** `lab/generative-fields/flow-layout.ts` runs one shared per-slot function over 16 slots:

- Ranks come from 120 pairwise order-key bits, with ties broken by slot index (`flow-layout.ts:140-163`). The key difference is rebuilt exactly with two ReLUs and scaled by 1024 before the boolean atom (`flow-layout.ts:111-119`).
- Each integer rank becomes a one-hot through integer ramps (`flow-layout.ts:167-184`).
- One-hot sums move slot fields into rank positions (`flow-layout.ts:223-249`).
- A greedy row flow over positions carries a cursor, the row top, and the row bottom (`flow-layout.ts:255-294`).
- The same one-hot routes the results back to the slots (`flow-layout.ts:298-332`).
- The circuit then scores its own output: 120 pairwise overlap checks, containment, minimum sizes, integer violation counts, a valid bit, and a continuous violation depth that repair can descend (`flow-layout.ts:337-440`).

Horizontal quantities stay in fractions of the inner width until one multiply converts them to pixels, and every division (fill ratio, means) happens in the JS scorer. The same compiled circuit produces a grid, a hero rail, a mosaic, a list, and a filmstrip purely by changing source cells.

**Responsive layout from real code.** `colsBoxMaxSizeXF` lowers `Math.floor` to a sum of threshold bits and division by a constant to multiplication by an FP32 reciprocal. The 2D grid block depends on the runtime column count, so the compiler builds it once per possible count (1..7) and combines the seven variants through an exact one-hot of the column count (`lab/trace-compiler/real-slice.ts:414-458`). The 1D lightbox loop `for (let i = newFocused - 1; i >= 0; i--)` unrolls over the static range with a per-iteration mask bit (`compile.ts:1053-1127`). That slice is 1,580 layers deep because positions accumulate sequentially through 221 photos.

**Keyed lookup.** data-adapter selects a row by `ReLU(1 - |id - selectedID|)` over integer IDs, ANDs it with the active bit, declares the selection one-hot, and reads fields through masked sums that gather lowering turns into direct reads (`lab/data-adapter/experiment.ts:121-162`).

**A per-item learned rule.** reusable-layout's width predictor is a 12-unit ReLU layer over eight features, with parameters stored in source cells. One compiled evaluator runs once per item (`lab/reusable-layout/model.ts:32-67`).

### What the numbers say about cost

Sequential UI logic costs depth. A select plus a comparison is roughly 4 to 13 layers per step once rounding points are preserved: about 9 layers per slot in the flow layout, about 7 per photo in the 1D lightbox, and 13 per word in my sequential word-wrap circuit with boolean-atom comparisons (34 with the exact sign cascade). Parallel logic costs weights instead: pairwise ranks, pairwise overlap checks, and pairwise text-fit comparisons all grow with the square of the item count while staying shallow. Occlusion culling for 221 photos (32 layers, 34k weights) is the clearest example of wide and shallow.

## 2. The trace compiler's taxonomy, re-read as missing constructions

`lab/trace-compiler/residue-census.ts` classifies the 221 statement units in the frozen gallery render path. This run: 64 compiled and verified (29.0%); 49 numeric candidates by syntax, never compiled; 27 DOM writes; 15 nullable state; 14 event-object plumbing; 9 string work; 9 browser side effects; 8 dynamic loop bounds; 6 debug-only; 6 DOM reads; 6 dynamic indexes; 4 state commits; 3 loop early exits; 1 unbounded range. The census is syntactic (`residue-census.ts:169-198`), so read its categories as a to-do list, not as compiler diagnostics.

### Lowering recipes the compiler already contains

Cheng prefers building graphs by hand, so the useful part of `compile.ts` is its recipes:

| Source construct | Recipe | Where |
| --- | --- | --- |
| affine step | `roundAffine`, only for shapes whose FP32 result doesn't depend on term order (one term, two terms with zero bias, or exact integers) | `compile.ts:210-252` |
| ternary / conditional assignment | `on * bit + off * (1 - bit)`; both branches must stay representable in FP32 or `Infinity * 0` produces NaN | `compile.ts:374-408`, `994-1003` |
| integer comparison | `relu(d) - relu(d - 1)` is the exact bit of `d >= 1`; equality is the AND of two such bits | `compile.ts:412-480` |
| continuous comparison | sign cascade: `relu(d)`, scale by a power of two, clamp, repeat until the total exponent passes 150 | `compile.ts:525-570` |
| `Math.min/max` | comparison bit plus select, with range shortcuts when ranges don't overlap | `compile.ts:572-624` |
| `Math.floor` | `low + sum of [x >= k]` bits, limited to 64 steps | `compile.ts:626-650` |
| bounded integer to one-hot | shared `>=` ramps differenced into equality bits | `compile.ts:654-671` |
| division by a constant | multiply by `fround(1 / k)` | `compile.ts:678-682` |
| division/modulo by a small runtime integer | one branch per possible divisor (up to 33), masked by the divisor's one-hot | `compile.ts:673-740` |
| modulo by a constant | `a - k * (count of multiples of k that a reaches)` | `compile.ts:744-760` |
| `if` | nested mask bits; numeric writes under a mask become selects | `compile.ts:1030-1046` |
| `for` with a runtime bound | unroll the static range (up to 4096 iterations), mask each iteration | `compile.ts:1053-1127` |
| `number \| null` | presence bit plus value; strict equality checks both | `compile.ts:1404-1419`, `1551-1556` |
| clamp helper | range narrowing inside ternary branches, so later lowerings see bounded values | `compile.ts:1471-1549` |
| small structural choice | one specialized variant per value, combined by one-hot | `real-slice.ts:414-458` |

### Missing constructions, one per census category

**Loop early exit, first match (3 units; also the `hitTest2DMode` rejection probe at fixture line 219).** The census names it but the compiler rejects `return` under a runtime condition (`compile.ts:864-866`) and all `break`/`continue` (`compile.ts:874-876`). There are two constructions:

- General first match: compute each item's condition bit, then feed the bits to `emitFirstActive`, or to a prefix "no earlier match" product (log depth as a tree). For `hitTest2DMode` over 221 photos that is 221 box hit tests (about 113 operations each with sign cascades) plus a 221-way first-active tree, roughly 25k operations at about 40 layers. The occlusion slice already shows the same width at 32 layers.
- Monotone first match: when the predicate is monotone in the index, the first match is a count. The anchor search (fixture lines 351-357) walks rows sorted by y looking for the first row whose bottom passes 20% of the window height. Since box bottoms increase with row index, the answer is `number of rows whose bottom has not passed`, one affine sum over comparison bits at depth 1. My word-wrap circuit uses this: the number of words that fit on a line starting at word i is the count of `words i..j fit` bits, because widths are non-negative.

**Dynamic loop bound (8 units; the `stepSpring` probe at fixture line 188).** The loop is `for (let i = 0; i < steps; i++) springStep(s)` with `steps` unbounded. Capping the step count (ui.md's `Math.min(300, ...)`) makes a masked unroll possible, but 300 steps at 8 layers each is 2,400 layers per spring. A better reformulation: the semi-implicit Euler step is linear in (displacement, velocity) for fixed stiffness, damping, and timestep, i.e. `[x', v'] = M [x, v]` with `M = [[1 - k dt², dt - b dt²], [-k dt, 1 - b dt]]`. So n steps equal `M^n`, which repeated squaring computes from the bits of n: about 9 rounds for n up to 511, each a 2×2 matrix product (8 multiplies) plus a select per entry. Every spring that shares stiffness and damping can share that one `M^n`, and each spring then costs one 2×2 matrix-vector product. The settle-and-snap step is nonlinear but runs once at the end. The FP32 rounding order differs from stepping one at a time, so the result drifts slightly from the JS version, while the physics stays the same. IndirectOS currently avoids all of this with a fixed four substeps per frame (`emitSpring`, `numeric-ui-core.ts:1165-1220`).

**Unbounded range (1 unit).** `Math.floor((now - animatedUntilTime) / msPerAnimationStep)` has no finite bound. Clamping the delta bounds it, but the compiler's floor recipe spends one threshold bit per integer step with a limit of 64, so 300 steps would still be rejected. The missing construction is a binary decomposition of a bounded integer: about log2(range) bits, each depending on the previous remainder, so log depth and log cost. That decomposition is also exactly what feeds the matrix-power spring above.

**Dynamic index (6 units, e.g. `rowsTop[Math.floor(focused / cols)]`, `data[hit]`, `data[anchor]`).** The compiler rejects runtime indexes (`compile.ts:1263-1276`). The construction: build the index's one-hot with integer ramps once, then compute each read as a masked sum. Declaring the one-hot lets gather lowering store zero weights per read. The gap is provenance. Gather lowering can only use one-hot groups that are declared or produced by `emitArgmax` or by `emitFirstActive` over proven bits, and "declared invariants do not flow through computation" (gather-lowering README). event-window lowers zero gathers for this reason, since its selections are products of bits that aren't proven bits.

**Runtime-sized arrays (inside the numeric candidates: `rowsTop.push` depends on the column count).** Push under a runtime condition is rejected (`compile.ts:1296`). The experiments use two constructions: a fixed capacity with active bits (data-adapter capacity 12, reusable-layout capacity 16, flow-layout visibility), or specialization per small structural choice (seven column counts). Specialization multiplies the block's cost by the number of choices; capacity multiplies the per-item cost by the maximum count.

**Nullable state (15 units).** Already implemented as a presence bit plus a value; the remaining units were never attempted. The `pointer = {x: -Infinity, ...}` sentinel has to become a presence bit, since masked selects need finite values.

**String work (9 units).** The strings are the photo id in the URL hash (`data[i]!.id === hashImgId`), key codes (`inputCode === 'ArrowLeft'`), cursor names, and CSS strings. None of them needs to be in the circuit. The id lookup can become an index computed in JS, or an integer id compared with data-adapter's integer equality. Key codes become one-hot event cells, as IndirectOS already does (`window-manager.ts:1499-1515`). The cursor becomes a one-hot output that the DOM projection maps back to a name. CSS strings are projection.

**Event-object plumbing (14 units).** Mechanical: event handlers store numeric cells (`downActive`, `downX`, `downY`) and the circuit reads cells.

**State commit (4 units).** Already supported by next-source write-back.

**DOM reads/writes and browser side effects (27 + 6 + 9 units).** These stay in JS. The circuit can compute their arguments, e.g. the `scrollTo` target and the focused index for `pushState`.

**Also missing, though not a census category:**

- Division by a runtime non-integer is rejected (`compile.ts:683`); the flow layout moves every division into JS.
- Order-dependent sums of three or more fractional terms are rejected (`compile.ts:234-236`). The construction is explicit nesting that follows JS evaluation order, or accepting drift.
- A prefix sum with a declared exactness policy. The 1,580-layer lightbox slice accumulates positions sequentially, and the README notes that a parallel prefix sum changes rounding order. Integer pixel positions, or an accepted drift bound, would allow a Kogge-Stone prefix sum: N log N weights and log N depth.

## 3. event-window: input handling and recurrence

### How events enter

The source table holds `downActive`, `moveActive`, `upActive` (at most one set), `eventX`, `eventY`, the last pointer position, the live press record, the slop latch, stored rectangle state (left, top, maximized, focused), and the behavior parameter cells (`circuit.ts:38-80`). Next-source zeroes the event cells after each step (`circuit.ts:455-460`). The demo event handlers only push raw inputs, keeping every coalesced move (`pointer-input.ts`, `demo.ts:401-410`). The render function then steps the circuit once per queued event before writing the DOM (`demo.ts:311-322`).

The September reassessment found that keeping only the last move changes behavior. Press, move 20 pixels away, return to the press point, and release: the full sequence cancels the click, but the compressed sequence toggles maximize. The oracle received the same compressed input, so the agreement counter missed the bug. `pointer-input.test.ts` now covers this through both evaluators.

### What the recurrence is

The boundary probe (`boundary-probe.test.ts`) proves that no function of the last K raw inputs can compute the committed rectangle position, for K up to 256. What works instead is state written only on events: aggregates latched at press and committed at release. The README calls this event-clocked recurrence, as opposed to frame-clocked integration such as springs, where every intermediate frame duration matters. Because latches are ordinary source cells, they can also hold what later gestures need: the archive records exist for double-click and flick velocity, and the README's next step adds a press timestamp latched by the same write gate.

### IndirectOS handles several events per frame differently

`window-manager.ts` keeps one slot per event kind. Its pointer is a select chain: `baseline = down ? downX : pointerX`, `moved = move ? moveX : baseline`, `pointer = up ? upX : moved` (`window-manager.ts:682-700`). `receivePointer` overwrites the slot's cells (`window-manager.ts:1256-1261`), so all moves in a frame collapse to the last one, and within-frame order is fixed as down, then move, then up. An up followed by a down in the same frame would be read as down-then-up. Photo events clear the other photo event bits, so the last event wins (`window-manager.ts:1263-1272`). This is the exact information loss the reassessment flagged in the event-window demo, and it is still present in the flagship.

### Measured: unrolling the step per queued event

`event-unroll.ts` inlines the event-window step K times in one circuit (`inlineCircuit`, `numeric-ui-core.ts:1407-1455`), chaining each copy's next-source wires into the next copy and adding five event cells per extra event. It checks against `createEventWindowMachine` stepping once per event, over 3,000 randomized frames per K:

| Events per frame | Sources | Operations | Layers | Stored weights | State mismatches | CPU µs, unrolled | CPU µs, K single steps |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 55 | 480 | 52 | 883 | 0 | 4.8 | 6.9 |
| 2 | 60 | 927 | 99 | 1,624 | 0 | 7.1 | 9.8 |
| 4 | 70 | 1,821 | 193 | 3,106 | 0 | 12.6 | 18.9 |
| 8 | 90 | 3,609 | 381 | 6,070 | 0 | 25.7 | 37.4 |

Each extra event costs about 47 layers and 740 weights. Unrolling is exact and trivial to build, but depth grows linearly with the number of events per frame.

### Reformulations for many events per frame

- **Sequential scan inside the circuit (measured above).** Exact for any behavior; depth is K times the step depth.
- **Several evaluations per frame (the demo).** No depth growth; costs one evaluation and one write-back per event. Cheap on CPU; on a GPU it means K round trips or K queued dispatches.
- **An associative fold of queued moves.** Between down and up, this behavior needs only whether any move crossed the slop distance and the last position. "Any move crossed" is a maximum over K Chebyshev distances (or an OR of K threshold bits), and the last position is a select of the last active slot. Both are associative, so the fold is log K deep: K distance computations (roughly a dozen operations each) plus a K-1 max tree. The limit: this only works when the information carried between events can be combined associatively (a maximum, a last value, a count, a sum). Events whose effect feeds a later event in the same frame need the scan: a click that changes focus, followed by a key press sent to the focused window.
- **Parallel scan over transition functions.** A step is a function from state to state, and function composition is associative, so a parallel prefix scan exists in principle. Representing a composed function is cheap only when the discrete state is a small one-hot finite-state machine (transition matrices multiply) and the continuous part is affine (drag deltas, spring steps). The press machine is close to that: released, pressed within slop, or dragging, times four rectangles, plus affine position updates. This is untested.

### Extending to keyboard input and gestures

- **Keys.** IndirectOS already turns ArrowLeft, ArrowRight, and Escape into one-hot event cells in JS. The general form is a key code one-hot over a bounded vocabulary, plus modifier bits, routed to the focused window by multiplying with the focus one-hot. Key-down and key-up become latches exactly like the press record.
- **Text entry.** Characters become integer codes at the boundary. A fixed-capacity code buffer with a caret index supports insertion as a shift: cell i becomes `select([i > caret], old[i], old[i - 1])` at the caret. That is O(capacity) selects at constant depth per keystroke, repeated per queued keystroke.
- **Double click.** Reads archive record 1 and a press timestamp latched at down; the README lists this as the natural next consumer.
- **Long press.** Latch the press time; each frame compares `frameTime - pressTime` against a threshold. That is a frame-clocked read of event-clocked state, with no integration.
- **Flick velocity.** A two-record shift register of move positions and timestamps, still written only on move events.
- **Multi-touch and pinch.** A fixed table of pointer slots. Each event routes to a slot by integer equality on the pointer id (data-adapter's `ReLU(1 - |id - slotID|)`), and each slot keeps its own press record. The pinch scale needs a ratio of distances, so it hits the runtime-division gap.
- **Timestamps.** `frameTime` is declared `0..Infinity` (gather-lowering README table). In FP32, millisecond timestamps lose whole-millisecond resolution past 2^24 ms, about 4.7 hours. Latched times should be stored relative to an event, e.g. "time since press".

## 4. Text and flow layout: where the boundary between prepared numbers and circuit arithmetic sat

### What the experiments did

- **generative-fields.** Layout arithmetic is in the circuit; text is not. `text-fitness.ts` calls pretext's `prepare()` and `layout()` in the JS scorer, after the circuit runs, to check whether each visible slot's label fits (`text-fitness.ts:95-121`). Under Bun there is no canvas, so a fixed per-character advance table stands in for measurement (`text-fitness.ts:28-59`). The import path is machine-local (`text-fitness.ts:13`). Per the reassessment, text fit was measured afterward, never optimized, and no text numbers entered the circuit.
- **reusable-layout.** Measurement happens at the boundary: canvas `measureText` with kerning disabled in the browser (`demo.ts:25-30`), or macOS AppKit Arial 14 word widths saved in `font-metrics.json` for studies. `prepareCaption` splits on spaces and measures each word and the space (`text.ts:6-10`). `wrapCaption` is a greedy JS loop (`text.ts:14-36`), the flow layout is JS (`layout.ts:32-61`), and the DOM renders explicit lines so browser wrapping can't disagree (`demo.ts:112-116`). The only circuit is the width predictor, whose single text feature is total caption width (`model.ts:12-30`). The README notes that total width cannot predict line breaks.
- **trace-compiler.** Strings are rejected. The one keyboard-derived value enters as a number (`edgeRubberBandVelocityX`, one of -2000, 0, 2000).

In every lab experiment, the prepared numbers were word widths and the circuit never received them. Text layout was always JS.

### pretext's own split

pretext's `prepare()` does the string work: segmentation, break kinds, canvas measurement. It produces arrays: segment widths, break kinds, per-grapheme advances for long breakable words, chunk boundaries, letter spacing, tab stops (`pretext-copy/src/line-break.ts:10-27`). `layout()` on the simple fast path is `walkPreparedLinesSimple` (`line-break.ts:305-492`): a sequential walk over segments with a few state variables (`lineW`, `hasContent`, `pendingBreakSegmentIndex`, `pendingBreakPaintWidth`). Its fit test is `lineW + w > maxWidth + lineFitEpsilon`, where the epsilon comes from an engine profile (`line-break.ts:314-315`). pretext already tolerates a small fit margin, so the boolean atom's small resolution margin is compatible with pretext's own semantics.

### Measured: greedy word wrap as a circuit

`text-wrap-circuit.ts` takes the source cells maxWidth, spaceWidth, N word widths, and N active bits, and outputs each word's line index and x offset plus the line count. The semantics match `wrapCaption`. Every variant below matched the JS reference on all 400 randomized trials per row: integer widths 10-300 with occasional 400-1200 wide words, half-pixel max widths, and garbage widths in inactive slots. Comparisons use either the boolean atom or the exact sign cascade.

Sequential chain (one step per word):

| Words | Comparison | Operations | Layers | Stored weights | CPU µs |
| ---: | --- | ---: | ---: | ---: | ---: |
| 8 | boolean | 194 | 102 | 333 | 5.2 |
| 16 | boolean | 386 | 206 | 677 | 9.9 |
| 32 | boolean | 770 | 414 | 1,365 | 21.6 |
| 64 | boolean | 1,538 | 830 | 2,741 | 41.7 |
| 64 | sign cascade | 2,818 | 2,174 | 4,469 | 102.1 |

Parallel with pointer doubling (prefix sums; `words i..j fit` bits for all pairs; the monotone count gives `next(i)`; ceil(log2 N) doubling rounds find the line starts; the line index is a prefix count of starts; x is the prefix sum minus a Kogge-Stone prefix max of start positions):

| Words | Comparison | Operations | Layers | Stored weights | CPU µs |
| ---: | --- | ---: | ---: | ---: | ---: |
| 8 | boolean | 1,129 | 41 | 1,896 | 7.0 |
| 16 | boolean | 5,061 | 50 | 8,852 | 28.8 |
| 32 | boolean | 22,773 | 59 | 40,740 | 126.7 |
| 64 | boolean | 102,597 | 68 | 185,908 | 560.1 |
| 64 | sign cascade | 142,917 | 89 | 240,340 | 746.2 |

Bounded line count (the same `next(i)` table, but walking at most L line starts with one one-hot gather per line; a line index is the count of line starts at or before the word; x telescopes over per-line prefix increments; an extra output bit reports text that needs more than L lines, and that bit matched the reference in every trial):

| Words | Max lines | Comparison | Operations | Layers | Stored weights | CPU µs |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 16 | 4 | boolean | 1,755 | 32 | 3,206 | 10.4 |
| 32 | 8 | boolean | 7,087 | 56 | 13,062 | 40.3 |
| 64 | 4 | boolean | 19,179 | 32 | 35,678 | 106.5 |
| 64 | 8 | boolean | 22,287 | 56 | 41,366 | 124.5 |
| 64 | 16 | boolean | 28,503 | 104 | 52,742 | 162.7 |
| 64 | 8 | sign cascade | 62,607 | 77 | 95,798 | 309.1 |

What these tables teach:

- The sequential chain is small but about 13 layers deep per word. That is the same depth problem as the 1,580-layer lightbox slice.
- The monotone count turns "find the first word that doesn't fit" into a sum, because every word width is non-negative. This is the key reformulation; without it each line start would need a first-match tree.
- Pointer doubling gives log depth but N² log N weights. It only makes sense when depth matters far more than size.
- The bounded line count is the practical middle: depth grows about 6 layers per line, not per word, and the weights are dominated by the N²/2 pairwise comparisons. For photo captions, where a lightbox might show 8 lines, 64 words cost 56 layers and 41k weights.
- A further reduction: if a minimum word width guarantees at most K words per line, only N×K comparisons are needed instead of N²/2.
- Not covered yet: soft hyphens, tabs, letter spacing, bidi, and long words that break per grapheme. Long words can be pre-split in prepare into grapheme segments, which pretext already produces as `breakableFitAdvances`, and break kinds can enter as per-segment `breakAfter` bits. That turns the simple fast path into the same count-and-walk structure over more segments.
- CPU µs per caption is much slower than plain JS (reusable-layout's whole JS layout with line breaking takes about 2 µs). These are serial JS numbers, not GPU numbers.

### Where the boundary could sit

- **JS prepare step, once per text change:** strings into segment widths, break-kind bits, and grapheme advances for long words.
- **Circuit, every frame:** line breaking, line x offsets, block height, card heights, the flow layout over cards, and springs on line positions.
- **DOM projection:** renders explicit lines, as the reusable-layout demo already does.

This keeps the whole caption-aware photo layout in one circuit while pretext's string analysis stays outside. Line breaks are discrete, so a line index jumps as the width changes; x offsets within a line stay continuous.

## 5. Constructions to promote into a shared UI library for circuits

These already exist, scattered across folders, each with a hand-written copy of `clamp01`, `absolute`, or threshold helpers (event-window `circuit.ts:556-575`, flow-layout `flow-layout.ts:79-119`, `numeric-ui-core.ts:1222-1235`).

**Decisions and comparisons**

1. Threshold bit with a boundary cell and a sharpness cell, emitted in exact or soft mode by the same builder: `bit(clamp01((boundary - measure) * sharpness + 0.5))` (`event-window/circuit.ts:152-164`).
2. Integer decision bit `relu(d) - relu(d - 1)` and integer-to-one-hot ramps (`compile.ts:412-427`, `654-671`; `flow-layout.ts:167-184`).
3. Exact sign cascade for continuous comparisons (`compile.ts:525-570`).
4. Order comparison with exact key-difference reconstruction and tie-by-index (`flow-layout.ts:111-119`).
5. Interval distance, rectangle hit score, and hit bits at integer band centers (`event-window/circuit.ts:547-554`, `577-608`).

**Selection and retrieval**

6. Priority first match (`emitFirstActive`) and tournament argmax (`emitArgmax`) (`numeric-ui-core.ts:1245-1366`).
7. Monotone first match as a count of predicate bits (my word-wrap prototype).
8. One-hot routing both ways, from items to rank positions and back, with defensive clamps (`flow-layout.ts:223-249`, `298-332`).
9. Integer id equality, the active AND same-id selection, and declared one-hot plus gather lowering for reads (`data-adapter/experiment.ts:121-162`; `assumeOneHot`, `numeric-ui-core.ts:143-154`).
10. Specialize per small structural choice, then combine by one-hot (`real-slice.ts:414-458`).

**State over time**

11. Event-clocked latch `select(eventBit, kept, fresh)` and the press record struct (active, position, grab point, snapshot bits), the drag-begin latch, and commit at release (`event-window/circuit.ts:266-302`, `350-388`).
12. Shift-register archive of K records (`circuit.ts:430-452`).
13. Arithmetic toggle `bit + toggle * (1 - 2 * bit)` (`circuit.ts:368-373`).
14. Per-event unroll through `inlineCircuit` (my `event-unroll.ts`), and the fixed-order select chain for one event per kind (`window-manager.ts:682-700`), each documented with what information it loses.

**Loops and numeric helpers**

15. Masked unroll of a runtime-bounded loop, with selects on every write (`compile.ts:1053-1127`), as a builder helper rather than a compiler pass.
16. Floor by threshold bits; division by bounded integers; modulo by a constant (`compile.ts:626-760`).
17. Presence bit plus value for nullable numbers (`compile.ts:1551-1556`).
18. Fixed capacity plus active bits for variable counts, active as a prefix (data-adapter, reusable-layout, my wrap circuits).

**Layout**

19. Greedy row flow over positions, in fraction-of-width units with one multiply to pixels (`flow-layout.ts:255-294`).
20. Self-scored validity: pairwise overlap, containment, minimum size, integer counts, a valid bit, and a continuous violation depth (`flow-layout.ts:337-440`).
21. Word wrap over prepared segment widths: sequential, bounded line count, and pointer doubling variants (`text-wrap-circuit.ts`).
22. Per-item learned rule with parameters in source cells, one evaluator reused per item (`reusable-layout/model.ts:32-67`).

## Things that surprised me

- Depth grew after the September correctness fixes (event-window 38 to 52 layers, flow layout 147 to 201). Preserving rounding points costs layers, so exactness policy now visibly trades against depth.
- The trace compiler emits zero boolean atoms, since everything is sign cascades. The lab circuits and IndirectOS still use the boolean atom (6 in event-window, 336 in the flow layout, 64 in IndirectOS). The cascade costs about 2.6 times the layers per comparison in my wrap circuit (34 versus 13 layers per word).
- IndirectOS still collapses all pointer moves in a frame to the last one and fixes the within-frame order, which is the information loss the reassessment found and fixed only in the event-window demo.
- The unrolled K-event circuit ran faster on CPU than K separate steps (25.7 µs versus 37.4 µs for 8 events), because each separate step pays source validation and write-back.
- The census's 65.3% "numeric" figure depends on 49 never-compiled units; the verified figure is 29.0% of all units.
- Gather lowering finds nothing in event-window, even though its selections are exact at runtime, because provenance checks don't see through products of bits.
