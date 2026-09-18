# Collections in one circuit

This prototype asks whether lists with many items, or with an order that changes at runtime, can live in one fixed Indirect circuit, and where O(n²) cost starts to hurt. It builds four things on the shared runtime (`numeric-ui-core.ts`, imported unchanged, not copied): a virtualized list of 10,000 rows in a native scroll container, a port of vibescript's draggable-cards, capacity routing of 1,000 items into 20 slots, and a port of gesture-flick-snap-target. Every behavior is checked against a JS reference transcribed from the original code (the vibescript demos, and the occlusion loop from scroll-anchor), not rewritten from the circuit.

## How to run it

From the repo root:

- `bun test lab/ui-exploration/lists`: 24 tests, about 4 s, 9 of them for the text rows.
- `bunx tsgo -p lab/ui-exploration/lists`: typecheck.
- `bun lab/ui-exploration/lists/report.ts [list] [routing] [cards] [cards-seeds] [flick] [hazard] [pieces]`: the heavy measurements (several minutes for all sections). It prints one JSON line per row and merges the selected sections into `results.json`.
- The text rows, added on September 17, 2026, whose heights come from pretext: see [How to run the text rows](#how-to-run-the-text-rows).
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
| `text-rows.ts`, `text-rows-prepare.ts`, `text-rows-reference.ts` | text rows: the cells, program and host, the row texts and their pretext breakpoints, and the plain JavaScript reference |
| `text-rows.test.ts`, `text-rows-report.ts`, `text-rows-browser.ts` | text rows: tests, measurements in Bun, and the headless Chrome check |
| `text-rows.html`, `text-rows-demo.ts` | the text rows page, DOM wiring only |

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
- Feed pretext text heights into the variable-height list and animate a row expanding. That exercises the in-circuit prefix sum on values that change every frame. Update, September 17, 2026: [text rows](#text-rows-with-pretext-heights-september-17-2026) feed pretext heights into a variable-height list through breakpoint cells, with appends and scroll anchoring, but without animation.
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

## Text rows with pretext heights, September 17, 2026

A fifth list: rows of chat message text whose heights come from pretext at the container's runtime width, in a table of up to 10,000 rows that grows while the page runs. Against the variable-height list above and [hn-thread](../hn-thread/README.md), three things are new. The width breakpoints sit in cells instead of weights, so the program reads them with index reads, and an edited or appended row only rewrites cells of the same compiled program. Rows are appended up to a capacity, with a named output when the table is full. And when a resize changes every row's height, the row at the top of the view keeps its position on screen.

### How to run the text rows

- `bun test lab/ui-exploration/lists/text-rows.test.ts`: 9 tests, about 3 s. With `TEXT_ROWS_COUNTS=1`, the random sessions test prints the counts under [Checks](#checks).
- `bun lab/ui-exploration/lists/text-rows-report.ts`: sizes and µs per frame in Bun, each variant in its own process, written to `results.json` under `text-rows`, about 2 minutes.
- `bun lab/ui-exploration/lists/text-rows-browser.ts --scratch <folder>`: bundles the page into the folder, serves it with cross-origin isolation headers, so `performance.now()` resolves to 5 µs, starts a headless Chrome with a fresh profile in the folder, runs checked scroll, resize, scroll and resize in one frame, edit and append frames at 1,000 and 10,000 rows, and writes `text-rows-browser` into `results.json` and a screenshot per size into the folder, about 1 minute.
- `bun lab/ui-exploration/lists/text-rows.html`: the page, with 9,900 of 10,000 rows at load, or e.g. `?capacity=1000&rows=900`. The slider sets the container width, and the buttons append messages, give the row 2 rows above the view a long or a short text, and scroll to the top. The edit button is disabled while the first row in view is row 0 or 1, since no row is 2 rows above it.

### What JavaScript does and what the program does

JavaScript prepares each text once, with pretext's rich inline layout through text-heights.ts's `prepareComment`, and finds the row's breakpoints with text-heights.ts's `tabulateStaircase` over container widths 375..1200. The host only writes whole-pixel widths, so the height function the staircase calls reads pretext at the floor of each width, and every change lands on a whole pixel. A row's table is 9 cells: its height at its minimum width, the minimum width, and 7 breakpoints, one per line the row loses as the container widens, e.g. `[512, 512, 900, 1201, 1201, 1201, 1201]` for a row that loses 2 lines at 512 px and 1 more at 900 px, padded with 1201, which no width reaches. Rows at or past the row count hold height 0, so appending a row writes 9 cells and a larger row count. Before each evaluation, JavaScript writes the container width, the viewport height, the scroller's scrollTop floored onto quarter pixels, and the row count. The program keeps every row's bottom from the last evaluation in 10,000 state cells, and JavaScript copies their next values back with one `Float32Array.set`.

| JavaScript | Program | Docs |
| --- | --- | --- |
| `height = baseHeight - 14 × breakpoints.filter(breakpoint => breakpoint <= containerWidth).length`, for every row | a binary search over the row's sorted breakpoints: 2 index reads, since the first read is at a constant position, 3 integer bit comparisons and 1 sum, 9 operations per row | patterns.md, "A loop over data that rarely changes" and "A layout function of one runtime number"; expressions.md, `table[index]` and `a >= b` |
| `bottoms[row] = bottoms[row - 1] + heights[row]` | a Brent-Kung network from lists' `emitPrefixSums`, exact since heights are whole pixels | patterns.md, "Running totals" |
| `anchorRow = previousBottoms.findIndex(bottom => bottom > scrollTop)` | a binary search over the state cells, 13 index reads and 14 comparisons at 10,000 rows | patterns.md, "`findIndex` when the test flips once along the items", under "Don't use it when" |
| `scrollTop = atBottom ? maximumScroll : Math.min(scrollTop + tops[anchorRow] - previousTops[anchorRow], maximumScroll)` | 2 index reads, `emitMinimumExact`, `emitMaximumExact` and `emitSelect` | expressions.md, `Math.min(a, b)` and `condition ? on : off` |
| `firstRow = rows.findIndex(row => bottoms[row] > scrollTop)` | the same binary search over the computed bottoms, then `Math.min(count, rowCount)` | the same entry |
| DOM slot k shows the row among the 64 from `firstRow` whose index % 64 is k | `firstRow % 64` from lists' `emitFloorOnGrid`, then 3 index reads and a few bits per slot | patterns.md, "Window slots" under "Not written up yet" |

The scroll position, the anchor row, the first row and the 64 slots are 1,290 operations at 10,000 rows, by subtraction, and the heights and running totals are the other 109,981.

### Anchoring

Before an evaluation, the DOM shows the last evaluation's layout at the scroll position the scroller reports now, which includes any scroll since then. The anchor row is the row at the top of that view: the first row whose bottom in the last evaluation's layout, kept in the state cells, is below today's scrollTop. The evaluation moves the view by as much as that row moved, `tops[anchorRow] - previousTops[anchorRow]`, which is 0 after a scroll, and the row's change of top after a resize, an edit above the view, or both in one frame, so one rule covers them, like CSS scroll anchoring.

The first version stored only the first row and its top after each evaluation, i.e. the row at the top before any scroll that came after. When a scroll and a height change landed in one evaluation, which the page allows since scroll events, the slider, the ResizeObserver and the append timer all lead to one render, the view jumped by (rows scrolled past) × (change in row height). The review's example: 2,000 rows, 100 px at 1200 px wide and 170 px below 500 px, a scroll of 50,000 px and a resize to 400 px in one evaluation put the view 35,000 px away from the row scrolled to. The current version gives the review's expected scroll position for that example, 136,040 px, and the random sessions and the browser check now include scrolls in the same frame as a resize or an edit. A view that showed the end of the rows before the evaluation, `scrollTop + viewportHeight >= previousTotalHeight`, shows the end after it, e.g. when a message is appended, like a chat log. The page sets `overflow-anchor: none`, so Chrome's own scroll anchoring doesn't also move the view, writes the spacer's height before the scroll position so the browser doesn't clamp it, and writes the program's `scrollTop` only when it differs from the scroller's.

### Fixed capacities and their fallbacks

Following behavior-choices.md's "A fixed maximum with a named fallback":

- Rows: 10,000, the size of the table. `full` is 1 at the capacity, and the page refuses more appends. `buildTextRows` refuses more than 16,384 rows: scrollTop lies on quarter pixels, and FP32 holds every quarter pixel only up to 2^22 px, which is 16,384 rows × 256 px. Above it, e.g. 4,194,304.25 becomes 4,194,304. The first version accepted up to 32,768 rows, and at 32,768 rows of 256 px, the review's scroll position 8,386,559.75 px was held as 8,386,560, so the first row came out one row too far down. At 16,384 rows, 1,980 scroll positions on quarter pixels around row tops near the end all gave the right first row.
- Breakpoints per row: 7. A text that loses more lines than that as the container widens keeps the 7 changes at the widest widths, and is laid out no narrower than the width of the first change it can't keep, like a CSS `min-width`. Each slot's `clamped` bit reports it, and the page marks the row with an orange left edge. The scroller hides horizontal overflow, so the part of the text past the container's right edge is cut off. 417 of the 10,000 generated messages get a minimum width above 375 px. This fallback adds no operations, since it only changes which breakpoints JavaScript writes.
- DOM slots: 64. `slotOverflow` reports rows in view past the last slot, which get no DOM node. Rows are at least 30 px tall, so 64 slots cover views up to 1,890 px tall.
- Row height: at most 256 px at 1200 px. text-rows-prepare.ts refuses a taller text, since the declared worst-case total height, 10,000 × 256 px, sets every magnitude in the program. A text between 160 and 256 px tall at 1200 px gets its minimum width where it would pass 256 px, before it loses 7 lines.
- Container widths within 375..1200 and viewport heights within 0..4096: the host clamps. A container narrower than 375 px, e.g. 356 px on a 390 px wide phone, lays rows out at 375 px, and the scroller cuts off the rest.
- `writeRow` refuses a table whose breakpoints decrease, sit at or below the row's minimum width, or leave less than one line, and names the row. Before, e.g. the breakpoints `[1201, 1201, 1201, 375, 375, 375, 375]` were accepted, and the next step failed with "anchorTop must be finite and within 0..2048, got -28", which named a state cell instead of the row. Rows at or past the row count must keep their empty table, since every row's height adds into the total height. The page's `appendRow` only counts the "too tall" refusal as a refused text, and throws any other error.

### Checks

- Heights against pretext: 64 rows, one in 8 of them at least 470 to 1,030 characters long, at every whole-pixel container width in 375..1200, with 3 and with 7 breakpoints per row, 105,728 heights, each equal to pretext's own height at `Math.max(containerWidth, minimumWidth)`. Every table's minimum width equals the reference's, which scans pretext's heights one pixel at a time down from 1200 px, and every base height equals pretext's height at that width.
- Heights at the 256 px limit: texts of 1,900, 2,300 and 2,700 characters, 170 to 226 px tall at 1200 px, keep fewer than 7 breakpoints, and their minimum widths equal the reference's.
- Random sessions against the reference: 2,800 frames, at 48 rows into 8 slots with 3 breakpoints per row, and at 200 rows into 16 slots with 7, of scrolls to random positions, to row edges and past either end, resizes to random widths, to breakpoints and to minimum widths, a scroll and a resize in one frame, viewport heights from 0 to 1,200 px, appends, edits, and a scroll and an edit in one frame. Half the sessions start with 0 to 3 rows. The scroll position, the first row, the total height, `full`, `slotOverflow`, and every drawn slot's row, top, height, layout width and `clamped` bit matched on every frame. The reference finds the anchor row with its own loop over the last frame's layout, and the test also checks anchoring without the reference: the last frame's drawn row that covers the DOM's scroll position keeps its position on screen. The frames included 756 resizes that changed the total height, 588 frames where that row's position on screen was checked this way, 72 of them with a scroll in the same frame, 35 appends that the view followed, 280 refused appends, 220 frames with `slotOverflow`, 1,028 clamped slots, 268 frames with nothing in view, 43 frames with rows shorter than the view, and 481 edits. `validateIndexReads` and `validateGrids` ran every 50 frames.
- A scripted session at 300 rows of at least 200 characters, which all get taller between 1100 and 400 px: resizing to 400 px and back keeps the top row of the view at the same position on screen, an edit 3 rows above the view grows the total height by that row's change and moves nothing in view, a scroll by half a view and a resize in one frame keep the row scrolled to at its position on screen, an append at the end is followed, an append while scrolled up moves nothing, and `full` turns on at the capacity.
- A scripted chat log that starts empty in a 600 px view and gets 30 appended messages: while the rows are shorter than the view, scrollTop stays 0, exactly the rows below the row count are drawn, and `slotOverflow` stays 0, and after that the view follows the appended rows.
- 10,000 rows: 24 frames of scrolls, resizes, and both in one frame, against the reference.
- Refused inputs: a container width outside 375..1200, decreasing breakpoints, breakpoints at the minimum width, a base height that leaves less than one line, and 16,385 rows.
- Mutations: the review changed one rule of the program at a time, and 4 of 22 changes still passed the tests, since no test ran rows shorter than the view, texts near the 256 px limit, or a scroll in the same frame as a height change. With the tests above, all 25 changes of a new mutation run fail at least one test, e.g. drawing rows past the row count, taking the anchor's previous top from the new layout, or accepting 32,768 rows.

### Measured results in Bun

Bun 1.4.0, on a machine shared with other agents, each variant in its own process, µs as the median of 11 batches of at least 10 ms, generated messages, 64 slots (`text-rows-report.ts`). "µs per frame" is what the host pays through `createEvaluator`: checking the source table, evaluating, and checking the next values. Where a row has a range, the scroll and resize processes measured it separately. Update, later on September 17, 2026: commit 54ce7d9 moved the grid and bit checks of cells.ts's validator into typed arrays, and at 10,000 rows with 7 breakpoints, one table check now takes about 90 µs and a scroll frame about 1,030 µs, against about 158 and 1,160 µs in a copy of the commit before, over 3 alternated processes each at load average 1.8 to 2.1. The tensor evaluator alone took 786 to 829 µs against 760 to 765 µs, which fits commit 831d097: it copies each layer's outputs with an indexed loop instead of `set` on a view, which is faster for IndirectOS's small layers, while a probe with one layer of 16,384 sums got 13% slower. The other numbers in this table weren't measured again.

| rows | breakpoints per row | source cells | live operations | layers | stored weights | index reads | µs per scroll frame | µs per resize frame | tensor evaluator only, µs | one table check, µs | plain JavaScript reference, µs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 7 | 10,004 | 12,235 | 84 | 21,995 | 2,213 | 129 | 127 | 83-85 | 15-16 | 150-157 |
| 10,000 | 7 | 100,004 | 111,271 | 122 | 202,135 | 20,221 | 1,175 | 1,204 | 738-765 | 159-166 | 1,970-2,185 |
| 10,000 | 3 | 60,004 | 81,271 | 122 | 142,135 | 10,221 | not run | 788 | 549 | 91 | 2,212 |
| 10,000 | 15 | 180,004 | 141,271 | 122 | 272,135 | 30,221 | not run | 1,933 | 1,124 | 312 | 2,145 |

- The table is 9 cells per row with 7 breakpoints, 90,000 cells at 10,000 rows, and 5 or 17 cells per row with 3 or 15, plus 10,000 state cells for the last evaluation's row bottoms. With 3 breakpoints, 1,662 of the 10,000 messages get a minimum width above 375 px, and with 15, 238.
- Preparing 10,000 rows with the fake canvas: pretext's prepare 184-185 ms, and the breakpoints 305-312 ms. Building the program took 181-182 ms, and compiling it with `createEvaluator` 489-496 ms.
- A scroll frame and a resize frame cost the same, since every operation runs on every evaluation. The plain JavaScript reference lays out every row with pretext on every frame; a JavaScript list that caches heights would pay that only on a resize.
- Rounding points: at 1,000 rows every comparison is an integer bit, 6,694 operations. At 10,000 rows, 60,708 operations are integer bits, and one comparison is a sign cascade, `Math.min(anchored, maximumScroll)`, 17 operations, since under the declared totals its operands span more than 2^24 quarter pixels.
- Copying the 10,000 state cells' next values back took about 140 µs per frame with a loop over their positions, and about 0.4 µs with one `Float32Array.set` over their contiguous range, which `createTextRowsMachine` checks.

### Browser check

Headless Chrome 153, a 1280 × 1000 window, devicePixelRatio 1, cross-origin isolated, with `text-rows-browser.ts`. Each frame runs the page's render now, then forces style and layout with a layout read, so the times leave out painting. Medians, with the 95th percentile in parentheses, over 300 scroll frames to random positions and row edges, 120 resizes to random widths, 40 frames with a scroll by up to half the view and a resize, 20 edits and 20 or 40 checked append frames:

| rows | frames | evaluation, µs | DOM writes, µs | style and layout, µs | total, µs |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1,000 | scroll | 155 (165) | 20 (25) | 170 (215) | 345 (400) |
| 1,000 | resize | 155 (180) | 25 (35) | 75 (120) | 250 (345) |
| 1,000 | scroll and resize | 155 (170) | 25 (30) | 90 (135) | 270 (320) |
| 10,000 | scroll | 1,465 (2,370) | 25 (40) | 185 (250) | 1,675 (2,620) |
| 10,000 | resize | 1,435 (1,490) | 30 (45) | 85 (115) | 1,555 (1,650) |
| 10,000 | scroll and resize | 1,465 (1,540) | 35 (70) | 115 (165) | 1,605 (1,755) |
| 10,000 | edit | 1,485 (1,575) | 40 (75) | 45 (75) | 1,570 (1,725) |
| 10,000 | append | 1,455 (1,485) | 40 (75) | 90 (135) | 1,585 (1,705) |

- Loading 9,800 rows took 2,218 ms from navigation: pretext's prepare with Chrome's canvas 156 ms, the breakpoints 266 ms, building 148 ms, and compiling 1,529 ms.
- Every frame passed its checks: the scroller's scrollTop equals the program's, the drawn rows are one run from the first row, every drawn row is in view, row r is in slot r % 64, and the drawn rows reach the bottom of the view.
- Anchoring as the browser drew it: after 114 of 120 resizes at 1,000 rows and 117 of 120 at 10,000, the anchor row's node was at the same position relative to the scroller. After the other 6 and 3, the row kept its top but got shorter than its part above the view, so it was no longer drawn, and the first row came after it. With a scroll and a resize in one frame, the row whose node covered the top of the view after the scroll, as the browser laid out the last frame, kept its position on screen in all 23 checked frames at 1,000 rows and all 24 at 10,000. The other frames of the 40 weren't checked: the view was at the end or clamped after the resize, or the row went above the view (1 frame at 1,000 rows). All 20 edits above the view at each size moved nothing in view, and the view followed all 20 and 40 checked appends. `full` turned on at the capacity, and the next appends were refused.
- The browser's own text layout against the heights from pretext's breakpoints, over the drawn rows of every checked frame: all 10,326 checks agreed at 1,000 rows, and all 10,683 at 10,000.
- The first version's generated messages had a 58-character URL word, and 77 of 9,894 and 50 of 10,275 checks differed, each time with Chrome drawing one line fewer. The review found the cause: when the URL word starts partway through a line, pretext moves the whole URL to the next line, while Chrome breaks inside the URL after a hyphen, e.g. after "notes-", and fills the current line. The review's probe compared the lines of rows 0..1,999 at container widths 375..1200 in 25 px steps: 1,117 of 68,000 heights differed, 1,115 of them in rows with the URL. The generated messages now use a 64-character hash instead, a word with no break opportunity inside it, so the list's checks don't depend on how URLs break. The same probe then found 5 of 68,000 heights differing, 3 of them in rows with the hash, and I didn't track down those 5. The URL case is worth reporting against pretext's rich inline line breaking.
- A window resize: the page's ResizeObserver used to schedule a render for the next animation frame, but ResizeObserver callbacks run after this frame's animation frame callbacks, so the frame painted right after a window resize showed rows laid out for the old width. The review's probe saw the scroller at 486 px while the program's last width was still 600 px. The ResizeObserver now renders right away when the size changed. A scratch probe resized the headless window to 520, 1000, 700 and 390 px wide, and inside a second ResizeObserver registered after the page's, the program's container width already equaled the scroller's width, 486, 966 and 666 px, or 375 px for the 356 px scroller, which the host clamps. A slider resize already rendered in this frame, so the ResizeObserver skips it.
- The edit button: at scrollTop 0, the first row in view is row 0, the button is disabled, and `editAboveView` edits nothing. Before, it edited row 0, which was in view. At row 354 the button is enabled and edits row 352.

### What fit well

- Text layout left the frame. The program knows nothing about text, only 9 cells per row, so resizing needs no JavaScript text layout, and an edited or appended message is a cell write through the same compiled program: 9 operations per row whether a message has 1 word or 200.
- One anchoring rule covers resizes, edits above the view, viewport changes, and a scroll in the same frame as any of them: a binary search over the last layout, two index reads, a subtraction and an exact minimum, exact because tops are whole pixels.
- Whole pixels and quarter pixels made nearly every decision a 2-operation integer bit: 6,694 integer bit operations and no sign cascade at 1,000 rows.
- The fallbacks were cheap to build and to check. `full` is 2 operations, `slotOverflow` a read, 2 comparisons and an AND, and the minimum width adds no operations, and the reference defines each fallback in plain JavaScript, e.g. the minimum width as a scan down from the widest width.

### What got awkward

- Every frame pays for every row's height and running total: 111,271 operations and about 1.2 ms in Bun at 10,000 rows, even for a scroll that changes no height. The scroll part alone, the scroll position, the anchor row, the first row and the slots, is 1,290 operations. For this list, the fixed program makes the scroll frame as expensive as the resize frame, where plain JavaScript with cached heights makes the scroll frame cheap and the resize frame expensive.
- Anchoring at the scroll position the DOM reports needs the last evaluation's layout, so the program keeps every row's bottom in a state cell: 10,000 more cells for the table checks and a copy back after each step. Against the first version, a frame in Bun went from 1,153 to 1,175 µs for scrolls and from 1,198 to 1,204 µs for resizes, once the copy was one `Float32Array.set`.
- Checking tables grows with the table, not with the program: at 10,000 rows, `createEvaluator` checks 100,004 source cells before the evaluation and the next values after it, about 160 µs each, and the tensor evaluator checks the source ranges again, so about a third of the 1,175 µs frame is checks.
- Every magnitude comes from the capacities: 10,000 rows × 256 px is 10.24 million quarter pixels, close to the 2^24 integers FP32 holds exactly. It already turns `Math.min(anchored, maximumScroll)` into a sign cascade at 10,000 rows. The capacity also has a ceiling from FP32: quarter pixels are exact only up to 2^22 px, so `buildTextRows` refuses more than 16,384 rows. At 16,384 rows, 1,714 operations are sign cascades, against 17 at 10,000, measured with 1 breakpoint per row, since the row searches' comparisons and the in-view tests become sign cascades too.
- Breakpoints per row trade operations against clamped rows: 7 leave 4.2% of the generated messages with a minimum width above 375 px, and 15 bring that to 2.4% for 30,000 more operations, 80,000 more cells and 1.6 times the µs per frame.
- text-heights.ts's `tabulateStaircase` sampled hn-thread's container widths 375..1200 and bisected to 1e-6 px. Reading pretext at the floor of each width gave whole-pixel breakpoints without changing text-heights.ts, and the list inherited hn-thread's width range. `tabulateStaircase` now takes the range of container widths and the bisection tolerance, and text rows passes 375..1200 from `textRowLayout`, so a container narrower than 375 px still lays rows out at 375 px, and the scroller cuts off the rest.
- Chrome ran the program slower than Bun, a median of 1,435 to 1,485 µs per evaluation against 1,175 to 1,204 µs, and compiled it in 1,529 ms against 489 to 496 ms.
