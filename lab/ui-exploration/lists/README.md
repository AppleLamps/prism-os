# Collections in one circuit

This prototype asks whether lists with many items, or with an order that changes at runtime, can live in one fixed Indirect circuit, and where O(n²) cost starts to hurt. It builds four things on the shared runtime (`numeric-ui-core.ts`, imported unchanged, not copied): a virtualized list of 10,000 rows in a native scroll container, a port of vibescript's draggable-cards, capacity routing of 1,000 items into 20 slots, and a port of gesture-flick-snap-target. Every behavior is checked against a JS reference transcribed from the original code (the vibescript demos, and the occlusion loop from scroll-anchor), not rewritten from the circuit.

## How to run it

From the repo root:

- `bun test lab/ui-exploration/lists`: 15 tests, about 1 s.
- `bunx tsgo -p lab/ui-exploration/lists`: typecheck.
- `bun lab/ui-exploration/lists/report.ts [list] [routing] [cards] [cards-seeds] [flick] [hazard] [pieces]`: the heavy measurements (several minutes for all sections). It prints one JSON line per row and merges the selected sections into `results.json`.
- `bun lab/ui-exploration/lists/list.html` and `bun lab/ui-exploration/lists/cards.html`: demo pages. Both bundle with `bun build`, but I haven't opened either in a browser, since nobody was awake to allow browser automation. A later Chrome check opened both pages, see [Browser check](#browser-check).

| file | contents |
| --- | --- |
| `common.ts` | exact integer bits, exact comparisons on continuous values, rounding and floors, prefix sums, spring matrix powers, the catch-up clock, a source table allocator |
| `list.ts` | virtualized list circuits, the stack layout, and the occlusion reference |
| `routing.ts` | capacity routing and its reference |
| `velocity.ts` | release velocity: the window search, the bounded division, and the optional clamp |
| `cards.ts`, `cards-reference.ts` | the draggable-cards circuit, and the demo's `render()` transcribed as a pure function |
| `flick.ts`, `flick-reference.ts` | the flick-snap circuit, and the demo's `render()` transcribed |
| `traces.ts` | differential drivers: pointer input generated from the reference's own projection (presses mostly land on cards), fed to both sides |
| `checks.ts` | list, routing, and velocity checks shared by the tests and the report |
| `report.ts`, `results.json` | measurements |
| `list.html`, `list-demo.ts`, `cards.html`, `cards-demo.ts` | demo pages, DOM wiring only |

## What was built

### Virtualized list (`list.ts`)

JS reads `scrollTop` and `clientHeight` of an `overflow: auto` container and writes them into two source cells. For each of 24 DOM slots, the circuit outputs a row index, a y position in content space, and a presence bit. Slot s always holds the visible row r with r mod 24 = s, so a row keeps its DOM node for as long as it stays visible, like vibescript's `domCache` keyed by id. Host contract: scrollTop and row heights are multiples of 1/4 px. JS floors scrollTop onto that grid. The floor changes nothing when scrollTop is already in whole, half, or quarter pixels, e.g. device pixels at devicePixelRatio 1, 2, and 4 (Scrolling.md, point 3). At ratios like 1.5 or 3, where device pixels are 2/3 or 1/3 px, it moves scrollTop down by less than 1/4 px.

Uniform rows: `first = floor(scrollTop / rowHeight)` is exact. `q = fround(scrollTop * fround(1 / rowHeight))` is within about 1e-7 of the true quotient, so `round(q)` is either the floor or the floor plus one, and one integer comparison of `round(q) * rowHeight` against scrollTop removes the extra one. The slot offset `first mod 24` uses the same construction. Slot s then holds `row = first + s - offset + 24 * [offset > s]`, and presence is two integer comparisons. Nothing depends on the row count.

Variable heights: row bottoms come either from a Brent-Kung prefix sum over height cells (exact on the quarter-pixel grid) or from JS. `above[r] = [bottom[r] <= scrollTop]` reads 1...1 0...0 along r, so the first visible row is a count, not a search. Slot s's one-hot over its candidate rows r = s, s + 24, s + 48, ... is `above[r - 24] - above[r]`, a difference of two bits with no products. The row index is a sum with constant coefficients over that one-hot, and y is a gather read of the tops through it.

Row data: either JS keeps it in an array keyed by the circuit's row index, or numeric data lives in source cells and the circuit reads it through the slot one-hots with gather reads. For uniform rows, that one-hot costs one shared ramp `relu(k - first)` per row plus one group member per row, because `[first <= r] = ramp[r + 1] - ramp[r]`.

### Capacity routing (`routing.ts`)

Each item gets a cheap visibility bit (`lower <= value < upper`, two integer comparisons). `count[i]` is the number of visible items among items 0..i (Brent-Kung on integers). `atMost[i][c] = [count[i] <= c]` reads 1...1 0...0 along i, so slot c's one-hot over items is `atMost[i - 1][c] - atMost[i][c]`. That marks the item where the running count first passes c, i.e. the (c + 1)-th visible item. `atMost[i][c] = relu(c + 1 - count[i]) - relu(c - count[i])`, and consecutive values of c share relus, so each item costs one relu per slot. Each slot reads the routed item's index and payload through gathers, then runs a hover test on it. The expensive per-slot path in this study is deliberately small, and its cost is reported separately.

### Draggable cards (`cards.ts`)

This is a port of vibescript's `demos/draggable-cards/index.ts`. Everything `render()` does between reading inputs and writing the DOM (handling inputs, layout, the animation tick, committing state) happens in one evaluation:

- State: a rank per card; x, y, and scale spring positions and velocities; `y.dest`, since the demo's swap loop reads the neighbors' previous destinations; the dragged card as a one-hot plus the grab offset; the last dragged card as a one-hot; a 24-sample pointer buffer by age, with a count and a flag marking the demo's `{x: 0, y: 0, time: 0}` reset sample; an animating bit; and the step backlog in ms.
- Pointer state (`up`, `down`, `firstDown`) is integer bits. Buffer pushes (up, move, down, in the demo's order) are one gather per buffer cell over the 8 combinations of event latches, including the demo's rule of shifting once per frame when the buffer holds more than 20 samples.
- The hit test runs against the springs' current positions with four exact continuous comparisons per card, followed by the first match in data order.
- The swap loops become counts: the dragged card passes every card ranked before it whose midpoint is below the pointer, and every card ranked after it whose midpoint is above the pointer.
- Layout from ranks, the pinned destination of the dragged card, springs, z bands (`n + 2` for the dragged card, `n + 1` for the last released card, otherwise the rank), and a cursor code.
- Springs follow vibescript's Animation.md rather than IndirectOS: fixed 4 ms Euler steps with catch-up of up to 300 steps. The step count becomes 9 bits through exact floors, and stage j applies the constant matrix M^(2^j) when bit j is set. Settling uses the demo's rule, `|v| < 0.01 && |dest - pos| < 0.01`.
- There are two layouts. `rankCount` recomputes the stack layout from ranks every frame with n(n - 1)/2 comparisons, and finds the first hit card through the rank permutation matrix (n² bits). `incremental` relies on a drag moving only one card: cards the drag passes shift by the dragged card's height, the card released this frame gets its top from one O(n) sum, and the first hit card is an integer minimum of `rank + n * (1 - hit)`. It needs `y.dest` to hold the layout top of every card that isn't being dragged. The demo maintains that after its first frame, so this layout's differential runs start from the reference's state after that frame.

Host contract: frame and event times are multiples of 1/64 ms. Event times are written relative to the frame time, so millisecond timestamps never lose resolution after hours. Pointer coordinates are multiples of 1/64 px within ±2^15 px, and card heights are multiples of 1/64 px; the demo's `30 + hash * 150` heights are quantized once. The frame delta is clamped to 2^14 ms and the backlog to 2^15 ms. The port takes one sample per event kind per frame, and JS clears the latches after each step.

Two limits that the demo doesn't have, applied in both the circuit and `cards-reference.ts`:

- The release velocity is clamped to ±2^16 px/s per axis. Without a clamp, no fixed range for the velocity cells holds: dt can be as small as 1/64 ms, and a press that jumps the pointer onto a far-away card can put a sample at the old position within the 100 ms window. On one run at 100 cards, the demo computed 206,584 px/s and the circuit stopped on its source range check. Spring velocity cells are declared as ±2^20 px/s, which leaves room for a clamped release added to a card that is still moving.
- The pointer buffer keeps its newest 24 samples. See "The demo's quirks" below for why the demo's buffer has no limit.

### Release velocity (`velocity.ts`)

The demo's loop `while (i > 0 && last.time - pointer[i - 1].time <= 100) i--` finds the longest run of samples, ending at the newest, whose times are within 100 ms of the newest. As arithmetic: `inWindow[age]` is an exact integer bit, `allWithin[age] = [inWindow[0] + ... + inWindow[age] >= age + 1]`, and the one-hot of the oldest in-window sample is `allWithin[age] - allWithin[age + 1]`. That stays exact when sample times are out of order. A gather reads the chosen sample, and `1 / dt` for dt in 0..128 ms uses one exact threshold bit per octave (a seed within 1/3) followed by four Newton steps `x * (2 - dt * x)`. The optional clamp is `v - relu(v - limit) + relu(-v - limit)`.

### Flick to a snap target (`flick.ts`)

This is a port of `gesture-flick-snap-target/index.ts`. The demo renders `spring1 + spring2 - restPos`. With equal stiffness and damping, each Euler step is linear, so the sum is exactly one spring that starts at the release position with the flick velocity and heads toward the corner. The rest position only picks the corner and places the marker. Squared distance to the four corners separates by axis, and the demo's strict `<` over [top-left, top-right, bottom-left, bottom-right] sends exact ties left and up, so choosing the corner takes two comparisons. The host contract and the release velocity clamp are the same as for the cards.

## Measured results

Structural counts are exact. "µs per frame" is the reusable tensor evaluator including source range validation, measured while about a dozen other agents shared the machine, so treat it as rough. IndirectOS for scale: 5,253 live operations, 192 layers, 11,598 stored weights, 31-39 µs.

### Virtualized list, 24 slots

| variant | rows | source cells | live operations | layers | stored weights | gathers | µs per frame | scroll trials, mismatches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| uniform, row data in JS | 1,000 | 2 | 280 | 19 | 625 | 0 | 1.8 | 2,000, 0 |
| uniform, row data in JS | 10,000 | 2 | 280 | 19 | 625 | 0 | 1.8 | 2,000, 0 |
| uniform, row data in JS | 100,000 | 2 | 280 | 19 | 625 | 0 | 1.9 | 300, 0 |
| uniform, row data through one-hot | 1,000 | 1,002 | 2,305 | 19 | 5,578 | 24 | 14 | 2,000, 0 |
| uniform, row data through one-hot | 10,000 | 10,002 | 20,305 | 19 | 50,578 | 24 | 121 | 2,000, 0 |
| uniform, row data through one-hot | 30,000 | 30,002 | 60,305 | 19 | 150,578 | 24 | 388 | 300, 0 |
| variable, Brent-Kung prefix in circuit | 1,000 | 1,002 | 6,177 | 25 | 14,279 | 24 | 41 | 2,000, 0 |
| variable, Brent-Kung prefix in circuit | 10,000 | 10,002 | 60,174 | 32 | 140,273 | 24 | 369 | 2,000, 0 |
| variable, Brent-Kung prefix in circuit | 30,000 | 30,002 | 180,171 | 35 | 420,267 | 24 | 1,164 | 300, 0 |
| variable, Brent-Kung prefix, row data through one-hot | 10,000 | 20,002 | 60,198 | 32 | 140,273 | 48 | 417 | 2,000, 0 |
| variable, blocked prefix in circuit | 10,000 | 10,002 | 60,092 | 11 | 629,961 | 24 | 848 | 2,000, 0 |
| variable, bottoms computed in JS | 10,000 | 10,002 | 40,193 | 8 | 100,311 | 24 | 258 | 2,000, 0 |

Every quarter-pixel scrollTop of 10,000 uniform rows (1,600,001 positions), at viewport heights 600 and 920: 0 mismatches against the occlusion test (`y + height > visibleTop && y < visibleBottom`) in rows, y, and slots. Checking the slot of every row matters, because rows alone can't catch a wrong slot offset: every offset in 0..23 gives the same set of rows.

### Capacity routing

| items | slots | live operations | layers | stored weights | µs per frame | patterns, mismatches | visibility / prefix count / routing and slots (operations) |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 100 | 20 | 5,130 | 21 | 14,420 | 36 | 208, 0 | 700 / 190 / 4,240 |
| 300 | 20 | 14,927 | 24 | 42,414 | 100 | 208, 0 | 2,100 / 587 / 12,240 |
| 1,000 | 10 | 29,104 | 27 | 80,188 | 196 | 208, 0 | 7,000 / 1,984 / 20,120 |
| 1,000 | 20 | 49,224 | 27 | 140,408 | 339 | 208, 0 | 7,000 / 1,984 / 40,240 |
| 1,000 | 40 | 89,464 | 27 | 260,848 | 647 | 208, 0 | 7,000 / 1,984 / 80,480 |
| 3,000 | 20 | 147,221 | 30 | 420,402 | 1,095 | 48, 0 | 21,000 / 5,981 / 120,240 |

The patterns include none visible, all visible, exactly 20, 19, 21 at the end, only the first item, only the last item, alternating items, and random filters at densities 0.001 to 0.5. The one-hot groups were validated on the reference evaluator. Phase 1's equality-bit construction for 1,000 into 20 was 81,961 operations and 660,424 stored weights.

Prefix count for 1,000 items into 20 slots, all 0 mismatches: chain 1,009 layers and 138,438 stored weights; blocked 13 layers and 155,244; Brent-Kung 27 layers and 140,408; one wide sum per item 11 layers and 636,939.

### Draggable cards

Differential runs use seeds 1 to 20 at every card count, with 3,000, 2,000, 1,500, and 600 frames per seed at 5, 20, 50, and 100 cards. Both layouts gave identical differential results, so the last four columns hold for both.

| layout | cards | source cells | live operations | layers | stored weights | µs per frame | differential frames, decision mismatches | runs where the animating bit differed | largest position error before that | largest position error |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| rankCount | 5 | 166 | 2,393 | 86 | 5,577 | 17 | 60,000, 0 | 1 of 20 | 0.0096 px | 0.0096 px |
| rankCount | 20 | 316 | 8,813 | 96 | 18,307 | 51 | 40,000, 0 | 2 of 20 | 0.0094 px | 21 px |
| rankCount | 50 | 616 | 26,378 | 100 | 54,564 | 432 | 30,000, 0 | 3 of 20 | 0.0103 px | 49 px |
| rankCount | 100 | 1,116 | 69,653 | 105 | 146,992 | 406 | 12,000, 0 | 7 of 20 | 0.0103 px | 21 px |
| rankCount | 200 | 2,116 | 208,703 | 110 | 451,849 | 1,308 | not run | | | |
| incremental | 5 | 166 | 2,387 | 82 | 5,628 | 17 | 60,000, 0 | 1 of 20 | 0.0096 px | 0.0096 px |
| incremental | 20 | 316 | 7,727 | 84 | 16,098 | 44 | 40,000, 0 | 2 of 20 | 0.0094 px | 21 px |
| incremental | 50 | 616 | 18,407 | 87 | 37,038 | 110 | 30,000, 0 | 3 of 20 | 0.0103 px | 49 px |
| incremental | 100 | 1,116 | 36,207 | 90 | 71,938 | 214 | 12,000, 0 | 7 of 20 | 0.0103 px | 21 px |
| incremental | 200 | 2,116 | 71,807 | 93 | 141,738 | 433 | not run | | | |

Decisions compared on every frame: card order, z index of every card, which card is dragged, cursor, and pointer buffer length. The animating bit is the demo's `stillAnimating`, and "before that" means the frames of each run up to and including the first frame where the circuit's bit differs from the demo's. Why the error jumps after that frame is explained under "Settling" below. The runs at 5 cards covered 2,926 reorder frames and 1,855 card releases; at 100 cards, 390 card releases. The release velocity clamp engaged on 2 of the 1,855 releases at 5 cards and on 13 of the 390 at 100 cards. The largest scale spring error was 2.8e-7 at 5 cards and 0.028 at 100 cards, where it includes the timeline shifts.

Longer runs from `report.ts cards-seeds` use the incremental layout on seeds 1 to 60, plus seed 302 at 50 cards and seed 401 at 100 cards. Before the release velocity clamp, seeds 10 and 401 at 100 cards and seed 22 at 50 cards stopped on the circuit's source range check.

| cards | runs × frames | differential frames, decision mismatches | runs where the animating bit differed | largest position error before that | largest position error | card releases, clamped | runs stopped by a range check |
| ---: | --- | --- | ---: | ---: | ---: | --- | ---: |
| 50 | 61 × 1,500 | 91,500, 0 | 15 of 61 | 0.0103 px | 49 px (3 runs above 1 px) | 2,923, 47 | 0 |
| 100 | 61 × 1,200 | 73,200, 0 | 24 of 61 | 0.0103 px | 173 px (11 runs above 1 px) | 2,348, 79 | 0 |

Where the operations go, as live operations (stored weights):

| section | rankCount, 20 cards | rankCount, 100 cards | rankCount, 200 cards | incremental, 100 cards |
| --- | ---: | ---: | ---: | ---: |
| clock and step bits | 50 (62) | 50 (62) | 50 (62) | 50 (62) |
| pointer state and buffer | 219 (222) | 219 (222) | 219 (222) | 219 (222) |
| release velocity, with the clamp | 296 (1,799) | 296 (1,799) | 296 (1,799) | 296 (1,799) |
| hit tests | 462 (840) | 2,302 (4,200) | 4,602 (8,400) | 2,302 (4,200) |
| first match by rank | 976 (1,824) | 20,896 (41,149) | 81,796 (162,306) | 1,397 (3,595) |
| drag ownership, pins, rank update | 540 (1,246) | 2,620 (6,126) | 5,220 (12,226) | 2,620 (6,126) |
| stack layout | 590 (1,520) | 14,950 (39,600) | 59,900 (159,200) | 1,003 (2,100) |
| springs | 5,363 (10,082) | 26,803 (50,402) | 53,603 (100,802) | 26,803 (50,402) |
| z, cursor, commit | 317 (712) | 1,517 (3,432) | 3,017 (6,832) | 1,517 (3,432) |

The two O(n²) sections of `rankCount` are 18% of the circuit at 20 cards, 35% at 50, 51% at 100, and 68% at 200.

### Flick to a snap target

854 live operations, 118 layers, 2,288 stored weights, 92 source cells, about 9 µs per frame. Over 125,000 frames (seeds 1 to 25, 5,000 frames each) with 4,312 flicks at speeds up to 20,300 px/s, there were 0 decision mismatches (cursor, dragging, marker). Positions stayed within 0.017 px of the demo's two springs, and rest positions within 0.017 px. No flick reached the release velocity clamp. On 678 frames (0.5%), the "schedule another frame" bit differs, because one spring per axis settles on a different frame than the demo's four springs. A release restarts the clock on both sides, so a differing bit at the end of one flick doesn't shift the next one.

### Pieces

All rows come from `report.ts pieces`, with the inputs as source cells.

| construction | live operations | layers | stored weights | check |
| --- | ---: | ---: | ---: | --- |
| one spring lane: 9 matrix-power stages (0..511 steps of 4 ms) plus settling | 84 | 41 | 152 | inside the card and flick differentials |
| IndirectOS `emitSpring`, for comparison (4 substeps of a runtime timestep) | 46 | 33 | 104 | |
| clock: `min(300, floor(elapsed / 4))` and its 9 bits, including the animating gate and the 2^15 ms clamp on elapsed | 49 | 15 | 62 | 0 mismatches over all 2,097,153 elapsed values on the 1/64 ms grid in 0..2^15, plus 200,000 random (animating, backlog, frame delta) inputs |
| release velocity: 24 samples, window search, gather, 4 Newton steps | 289 | 32 | 1,787 | 0 failures over 3,949 random buffers against the demo loop, largest relative error 1.9e-7 |
| the same with the ±2^16 px/s clamp | 295 | 34 | 1,797 | 0 failures over the same buffers against the clamped loop, 69 of them clamped |

Hazard, measured on all 8,192 values of dt on the 1/64 ms grid in 0..128. Built as a plain `affine` over exact bits, the reciprocal seed has a largest relative error of 2.33 (at dt = 127.97 ms), and after four Newton steps the reciprocal has a largest relative error of 9.0 (at dt = 96.03 ms), with 1,709 values more than 1% off. Built with `roundAffine`, the seed is within 1/3 and the reciprocal after Newton within 1.4e-7.

## What this shows about how far the approach goes

### What fit well

- **Virtualized scrolling is flat and tiny when row positions are arithmetic.** A uniform list costs 280 live operations, 19 layers, and about 2 µs per frame at 1,000, 10,000, or 100,000 rows, and it's exact in rows, y, and slots on all 1.6 million quarter-pixel scroll positions of 10,000 rows. The exact floor and the modulo that keeps slots stable each take fewer than 10 operations.
- **When a predicate flips only once along an index, the circuit counts instead of searching, and the answer's one-hot is a difference of neighboring bits, with no products.** That single idea gave the first visible row and each slot's one-hot in the list, the (c + 1)-th visible item in routing, the oldest sample in the velocity window, and the first hit card in the incremental layout.
- **Rank counting reproduces the demo's swap loops exactly.** Order, z bands, the dragged card, cursor, and pointer buffer length matched the transcribed demo on every differential frame: 284,000 frames over both layouts at 5, 20, 50, and 100 cards, plus 164,700 frames from the longer runs at 50 and 100 cards.
- **Fixed-step springs with catch-up fit.** Nine matrix-power stages cover the demo's 0..300 steps of 4 ms, independent of frame rate, for 84 operations per lane including settling. That's 1.8 times IndirectOS's frame-rate-dependent `emitSpring`. Until the first frame where the animating bit differed, positions stayed within 0.0103 px of the float64 demo in every card run.
- **Division by a runtime time difference is cheap:** the whole release velocity, window search included, is about 290 operations (295 with the clamp) within 2e-7 relative error.
- **Two superposed springs are one spring** in a live port, with 0 decision mismatches over 125,000 frames.
- **Quantizing at the boundary makes most decisions exact.** Quarter-pixel scroll, 1/64 px pointers, and 1/64 ms times turn the scroll decisions, the swap counts, and the velocity window search into integer comparisons or comparisons on a preserved FP32 difference. Two kinds of decisions still read drifting FP32 spring state: hit tests on moving cards, and the settle rule (see "Settling" below).

### What got awkward

- **Per-row cost when row data or heights live in the table.** Reading row data through the slot one-hots costs 2 operations and 5 stored weights per row, about 12 µs per 1,000 rows on this CPU executor. Runtime heights with the prefix sum cost 6 operations and 14 stored weights per row, about 37 µs per 1,000 rows. At 10,000 rows that's 121 µs and 369 µs per frame, more than all of IndirectOS. The 24 slots stay fixed either way; the growth comes only from scanning the table. Keeping row data in JS, keyed by the circuit's row index, costs nothing.
- **O(n²) starts to hurt around 50 cards, and a drag doesn't need it.** In the direct port, the permutation matrix and the stack layout are 35% of the circuit at 50 cards and 68% at 200 cards (141,696 of 208,703 operations). Because a drag moves one card, the same decisions come out of an O(n) circuit: 36,207 operations at 100 cards instead of 69,653, and 71,807 at 200 instead of 208,703. The catch is that the incremental layout depends on laid-out state from earlier frames, so it can't start from arbitrary state the way the demo's first frame does. What remains is mostly springs: 3 lanes per card at about 89 operations each, 74% of the incremental circuit.
- **Routing costs O(items × slots)**, about 2 operations per item per slot plus 9 per item. It beats running the expensive path on every item once that path exceeds about 2 + 2 × slots operations per item, e.g. 42 operations for 20 slots, which one spring lane already passes.
- **Settling: a decision on drifting FP32 state, and one differing bit shifts every card's animation.** The settle rule compares spring velocity and distance against 0.01. The circuit's FP32 matrix powers drift from the demo's float64 loop by up to about 0.01 px on cards thousands of px down the stack, so now and then a spring settles on a different frame than the demo's. For example, at 100 cards (seed 9, frame 356), card 68's y spring has |v| = 0.01056 in the demo, and the circuit settles it. When that spring was the last one still animating, the two sides disagree on `stillAnimating`. The demo's clock restarts from the frame time once nothing animates, so on the next frame one side steps every spring 0 times and the other steps the backlog plus the frame delta. Every card that starts moving then runs up to a frame ahead of or behind the demo, and positions differ by several px until the springs settle again: 5.9 px four frames later in that example, and up to 173 px on other runs. The animating bit differed in 1, 2, 3, and 7 of 20 runs at 5, 20, 50, and 100 cards, and in 15 and 24 of the 61 longer runs at 50 and 100 cards. Decisions still matched on every frame.
- **Hit tests on moving springs have the same exposure** when the pointer sits within about 1e-4 px of an edge, but no decision mismatch occurred.
- **Hazard: an exact integer bit stops being exact inside a weighted sum.** `relu(v) - relu(v - 1)` is exact as its own rounding point, but an ordinary `affine` with fractional weights inlines both relus. With relu values up to 8,192, the running sum rounds at magnitudes near 1e5. The reciprocal seed came out up to 2.33 off, and four Newton steps amplified that to 9.0 at one value of dt, with 1,709 of the 8,192 dt values more than 1% off. Building the weighted sum with `roundAffine` keeps each bit as its own wire and fixed it.
- **Hazard: a path masked by a zero gate still computes.** On frames without a release, the velocity's raw `dt` was far outside 0..100, Newton overflowed to Infinity, and `0 * Infinity = NaN` leaked through the mask into spring state. The fix was to clamp the inputs of every masked path into their declared range.
- **Hazard: a value computed from input timing has no natural range.** The release velocity divides by a time difference that can be 1/64 ms, so the card port stopped on its source range check on 3 seeds beyond the ones the first report used (10 and 401 at 100 cards, 22 at 50 cards). A clamp in both the circuit and the reference fixed it, at the cost of one more difference from the demo.
- **The demo's quirks have to be modeled to match its decisions, and some can't be followed with a fixed buffer.** The pointer buffer shifts at most once per frame and resets only on a frame that ends with the pointer up. Once it holds more than 20 samples, each frame with an up, a move, and a down (3 pushes, 1 shift) grows it by 2, without limit. The port and its reference both keep the newest 24 samples, which changes the release velocity only when more than 24 samples fall within 100 ms of the newest one.
- **Authoring volume and depth.** `cards.ts` is 481 lines for about 127 lines of demo `render()`, and the circuit is 80-110 layers deep, mostly from spring stages.

### What stayed outside the circuit

- Reading `scrollTop` and `clientHeight`, quantizing coordinates and times, converting event timestamps to values relative to the frame, clamping the frame delta, and clearing latches after each step.
- Row labels and other strings (a JS array keyed by the circuit's row index), DOM node creation, and turning cursor codes and dragged bits into CSS strings.
- Merging touch and mouse events: the port takes one sample per event kind per frame.
- The incremental layout's starting state, which comes from one ordinary layout.

## Open questions and next steps

- An executor instruction that reads `table[index]` from an exact integer wire, like a shader texture fetch, would make one-hot data reads O(1) per slot instead of O(rows). With a binary search built from a few such reads, variable heights would stop costing a comparison per row. Update, September 16, 2026: the repo root has had this instruction as `circuit.indexRead` since September 14, 2026, and index-read measured both uses ([Merged from index-read](#merged-from-index-read-september-16-2026)). This folder's circuits haven't been rebuilt with it.
- The incremental layout suggests a general question: which UI changes can be written as small updates to laid-out state (insert, delete, move one item), and which force a recompute? The demo's persistent `y.dest` is what made the O(n) drag possible.
- None of these timings use generated JS. Phase 1 measured it at about 10 times faster than the executor for IndirectOS, so these numbers should be rerun that way before judging CPU cost.
- Check both demo pages in real browsers, including Safari's whole-pixel scrollTop, devicePixelRatio 1.5 and 3, and touch input.
- Feed pretext text heights into the variable-height list and animate a row expanding. That exercises the in-circuit prefix sum on values that change every frame.
- A settle rule on integer-quantized spring state, or on a step count, would make animation ending exact, and would remove the timeline shifts above. The same question applies to hit tests on moving springs.

## Merged from index-read, September 16, 2026

[index-read](https://github.com/chenglou/indirect/tree/exploration-2026-09/lab/ui-exploration/index-read) added an index read instruction, which copies `candidates[floor(index)]` in 1 operation at any table size, to a copy of the runtime. The repo root took the instruction on September 14, 2026 as `circuit.indexRead` ([execution-model.md](../../../docs/execution-model.md#index-reads)), and index-read was removed on September 16, when its runtime copy moved into [pixel-output](../pixel-output/numeric-ui-core.ts). These are its list workloads, measured on September 13, 2026 in that copy. Each variant matched a plain JS reference at 305 scroll offsets (fixed heights), 303 scroll offsets (variable heights) or 200 random visibility patterns (filtered list), and each compiled program matched the reference evaluator on every live wire. index-read's demo, a 10,000-row list filling 24 DOM slots with a menu that switches between three circuits, is at the tag, and `list.html` here shows the same kind of list.

- **Fixed heights.** 24 slots each read 3 fields from columns of source cells, over rows 28 px tall, with `firstRow = floor(scrollTop / 28)` from `emitFloorDivide`, now in [numeric-library](../numeric-library/README.md#merged-from-index-read-september-16-2026). With index reads the list was 153 live operations, 9 layers and 204 stored weights at both 1,000 and 10,000 rows, and it stored no table positions, since each column of source cells is evenly spaced. At 10,000 rows, a ReLU one-hot of firstRow took 750,154 operations, 12 layers and 2,210,132 stored weights dense, and 30,154 operations, 11 layers and 700,000 table entries with gather lowering. index-read's recognition pass, which computes a ReLU one-hot's position from its index wire, also reached 153 operations, but still stored 690,000 table entries, because each slot's column was padded with zero cells, and it had to build the one-hot first: 561 ms against 9 ms with the instruction. Most of the 28 µs per evaluation at 10,000 rows went to checking the ranges of 30,001 source cells.
- **Variable heights.** Row tops are prefix sums prepared in JavaScript (10,001 cells), with 2 fields per row. A binary search reads `top[low + step]` for step = 2^13 down to 1, and adds the step when `top[low + step] <= scrollTop`: 215 operations, 57 layers and 318 stored weights at 10,000 rows, and 195 operations and 41 layers at 1,000. Counting `[top[row] <= scrollTop]` over every row took 30,143 operations in 5 layers at 10,000 rows. For comparison, the row bottoms computed in JavaScript above, read through gathers, take 40,193 operations in 8 layers.
- **Filtered list.** Each item has a visibility bit in a source cell, and slot k shows the (k + 1)-th visible item, e.g. under a search filter. Phase 1's compaction, one wide sum per item that counts earlier visible items, then one equality bit per item and slot read through gathers, took 81,961 operations, 6 layers and 660,424 stored weights for 1,000 items into 20 slots. Prefix counts of the bits from a Kogge-Stone network, which is exact on integers, then one binary search per slot with index reads, took 10,000 operations, 49 layers and 19,396 stored weights, and reached 10,000 items into 24 slots at 125,324 operations, 69 layers and 249,636 stored weights. Compaction wasn't built at 10,000 items, since its per-item sums alone would be about 50 million stored weights. Capacity routing above takes 49,224 operations for 1,000 items into 20 slots.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/lists/list.html lab/ui-exploration/lists/cards.html`, which serves the two pages at `/list` and `/cards`.

- Both pages load with no console errors.
- `list.html`, uniform rows: 280 live operations, 19 layers, 625 stored weights, 2 source cells. A script scrolled to 100 positions (e.g. 0, 39.75, 12,345.25, past the end, and random quarter-pixel offsets) and checked the drawn slots after each one: every slot holds a row whose index mod 24 is the slot, every drawn row is in view, the drawn rows are contiguous and cover the viewport, and y is 40 px times the row. 0 problems.
- `list.html`, variable heights with the prefix sum in the circuit: 60,174 live operations, 32 layers, 140,273 stored weights, 10,002 source cells, built in 368 ms. The same check over 100 positions found 0 problems. After "New heights" and with row colors read through the slot one-hots (60,198 live operations, 20,002 source cells), it found 0 problems again, and every drawn swatch had its row's hue.
- The panel's evaluation median was 300 µs or less for uniform rows, about 3 ms for variable heights, and 0.8 ms after the one-hot rebuild. Chrome gives these pages `performance.now()` in steps of 0.1 ms, so these medians are coarse.
- Reading positions back from inline styles needed a tolerance: Chrome serializes style numbers to 6 significant digits, e.g. `translateY(12353.75px)` reads back as `12353.8px`, so past 100,000 px a read-back position is only accurate to 0.5 px. The check allows for that.
- `cards.html` with 5 cards (2,393 live operations, 86 layers, 5,577 stored weights): dragging "Drag Me 0" down past card 3 reorders the stack, and the released card gets z-index 6, i.e. n + 1. With 20 cards (8,813 live operations, 96 layers, 18,307 stored weights), a scripted drag of card 12 upward over 40 frames showed the grabbing cursor and 0.7 opacity during the drag, and card 12 landed between cards 6 and 7. With 100 cards (69,653 live operations, 105 layers, 146,992 stored weights, step median 900 µs), a scripted drag of card 3 downward landed it after card 7, and no range check stopped the machine.
- No fixes were needed.
