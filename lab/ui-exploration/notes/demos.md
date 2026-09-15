# Vibescript demos as circuits

This note reads every demo under ~/github/vibescript/demos and asks, for each one, what it would take to write it in the IndirectOS style: a Float32Array source table, one compiled circuit of affine, ReGLU and boolean operations, and JS that records inputs, writes the next-source outputs back, and projects the remaining outputs onto the DOM. For each demo it covers what the demo does, its algorithms with file:line references, the state it keeps, how it animates, the computational shape of its logic, and a circuit sketch. It ends with patterns shared across demos and a ranking of which demos would teach us the most if ported.

Line numbers in `numeric-ui-core.ts` refer to commit c3d8e54 (September 5, 2026); on September 14, 2026 the file grew from 1,653 to 3,158 lines.

While reading, several demo algorithms looked impossible or expensive as circuits until they were reformulated. I tested seven of those reformulations with small scripts against the real builder in `numeric-ui-core.ts`. The scripts are in scratchpad/phase1/demos/ and each one prints the numbers quoted here. All timings are CPU JavaScript on this laptop.

## Baseline: IndirectOS today

`stats.ts` compiles the production machines:

| Circuit | Sources | Live operations | ReGLU | Boolean | Layers | Widest layer | Stored weights | Gather reads |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| window manager with Photos inlined | 201 | 5,253 | 2,843 | 64 | 192 | 173 | 11,598 | 12 |
| Photos standalone | 82 | 2,358 | 1,287 | 36 | 91 | 147 | 5,574 | 0 |

The reusable evaluator (`createTensorEvaluator`) takes a median 32 µs per frame for the window manager. A full `machine.step` takes a median 128.7 µs, because it also validates the whole source table before evaluating and the outputs afterwards (window-manager.ts:1288-1290). Validation costs about three times as much as the circuit itself.

Three properties of IndirectOS differ from how the vibescript demos are written, and they matter for porting:

- Springs are not fixed-step. `emitSpring` runs four substeps of `frameDuration / 4`, with the frame duration clamped at 32 ms (window-manager.ts:403-416, numeric-ui-core.ts:1181-1197). At 60 fps a substep is 4.17 ms, at 120 fps it is 2.08 ms, and a 100 ms stall loses 68 ms of simulated time. The vibescript demos all step a fixed 4 or 6 ms and catch up by up to 300 steps (Animation.md:40-74, e.g. draggable-cards/index.ts:242-250). In IndirectOS the timestep is a runtime wire, so every substep multiplies by it, and stiffness and damping are source cells rather than constants (window-manager.ts:139-145).
- Instancing duplicates operations. Each window, photo and thumbnail gets its own copy of the logic in the operation list (e.g. window-manager.ts:463-582, photo-gallery.ts:445-517). Nothing in the executor applies one set of weights to a batch of instances, so cost grows linearly with the item count. Demos with thousands of instances (life-calendar's 27,393 dots, per-pixel shaders) don't fit this model.
- The stacking order is a 4×4 permutation matrix, and bringing a window to the front builds products over rank × selected rank × window (window-manager.ts:828-859), which is cubic in the window count.

## Reformulations measured for this note

### 1. A prefix sum can be one layer and still match sequential FP32 exactly

Every list demo stacks items with `top += height` over a sequence (draggable-cards swap-layout.ts:29-40, scroll-anchor anchor-layout.ts:92-127, nicer-hacker-news hn-thread-layout.ts:74-89 and 108-170, photo-gallery layout.ts:198-206, mobile-test-standalone index.ts:462-470). The trace compiler README reports 1,580 layers for the gallery's 1D slice because positions accumulate sequentially through 221 photos, and says a parallel prefix sum would change the rounding order.

There is a third option. Author each output as its own fold: `top[i] = roundAffine([paddingTop, height[0], ..., height[i-1]])`. The FP32 evaluation of one affine row is `fround(... fround(fround(paddingTop) + height[0]) ... + height[i-1])`, which is the same chain of rounding steps the JS loop performs. `cumsum.ts` uses text-like heights (whole line heights plus an animated fraction) over 200 trials:

| Items | Construction | Layers | Stored weights | Mismatches against a sequential `Math.fround` fold |
| ---: | --- | ---: | ---: | --- |
| 221 | chain of `roundAffine` | 221 | 442 | 0 |
| 221 | one `roundAffine` row per output | 1 | 24,753 | 0 |
| 221 | one builder `affine` row per output | 1 | 24,752 | 4,717 (up to 0.0039 px) |
| 1000 | chain of `roundAffine` | 1000 | 2,000 | 0 |
| 1000 | one `roundAffine` row per output | 1 | 501,501 | 0 |
| 1000 | one builder `affine` row per output | 1 | 501,500 | 18,003 (up to 0.0156 px) |

The cost moves from depth to width: n²/2 stored weights. The builder's ordinary `affine` sorts terms by wire index, which moves `paddingTop` (the highest wire in this script) to the end of the fold, and that alone causes the drift in the third row of each size. Seen as matmul, a prefix sum is a lower-triangular all-ones matrix, so the substrate expresses it as one sparse multiply. A dedicated cumulative-sum operation in the executor would keep depth 1 and bring weights back to O(n), but it would no longer be a plain matmul.

This only applies when the order of items is static. When the order changes at runtime (drag reorder), heights must be combined with order bits, see reformulation 3.

### 2. Springs as powers of a constant step matrix

With constant stiffness k, damping b and step size Δ, one semi-implicit Euler step is a constant 2×2 matrix M acting on (displacement from the destination, velocity). N steps is M^N. Writing N in binary and applying the constant M^(2^i) whenever bit i is set gives 9 stages for 0..511 steps. Each stage is two affine rows plus two selections, and there is no runtime multiplication by a timestep. The same construction with the exact per-step matrix e^(AΔ), computed at compile time in float64, reproduces the closed-form spring sampled at multiples of Δ in every damping regime. The 1/omega term that Animation.md:18 warns about near critical damping never appears at runtime.

`spring-power.ts`, 2,000 random trials per regime, displacement up to ±1000 px, velocity up to ±4000 px/s, 0..300 steps:

| Regime | Euler powers vs the JS `springStep` loop | Exact powers vs the analytical formula | For context: JS Euler loop vs analytical |
| --- | ---: | ---: | ---: |
| k=290 b=24 (draggable-cards) | 9.4e-5 px | 1.1e-4 px | 30.9 px |
| k=333 b=12 (spring-comparison) | 7.8e-5 px | 9.0e-5 px | 34.7 px |
| k=100 b=20 (critically damped) | 1.3e-4 px | 1.4e-4 px | 22.0 px |
| k=100 b=60 (overdamped) | 1.4e-4 px | 1.1e-4 px | 19.0 px |

Size of one spring lane:

| Construction | Layers | Live operations | ReGLU | Stored weights |
| --- | ---: | ---: | ---: | ---: |
| IndirectOS `emitSpring` (4 runtime-timestep substeps plus settle logic) | 45 | 78 | 45 | 168 |
| 9-stage matrix powers, step bits given | 27 | 81 | 36 | 153 |

The step bits come from the clock. `step-bits.ts` computes N = min(300, floor(elapsedMs / 4)) and its binary digits inside the circuit. It builds 300 independent threshold bits `t[n] = [elapsed >= 4n]` (a thermometer code), then digit i = Σ_m (t[(2m+1)·2^i] − t[(2m+2)·2^i]), which is one affine layer. Over 20,000 trials there were 0 mismatches, using 13 layers, 3,911 live operations and 6,298 stored weights, computed once per frame and shared by every spring. Computing the same digits by sequential subtraction took 115 layers. The leftover part of a step (`elapsed − 4N`) is one more affine row and plays the role of `animatedUntilTime`.

What this costs: stiffness and damping must be compile-time constants for each family of springs, which every vibescript demo satisfies. If they live in source cells, as in IndirectOS, M^(2^i) becomes a polynomial in runtime values and the construction falls back to stepping with multiplies. Settling (`|v| < 0.01 && |dest − pos| < 0.01`, then snap) is unchanged and can reuse the settle logic of `emitSpring`.

### 3. Rank counting instead of a swap loop

draggable-cards reorders by repeatedly swapping the dragged row with a neighbor while the pointer is past that neighbor's midpoint (index.ts:215-223). The loop's result has a closed form. Store an integer rank per card. A card ranked before the dragged card is passed when the pointer is above its midpoint, and a card ranked after it is passed when the pointer is below its midpoint. The dragged card's new rank is `rank − passedUpCount + passedDownCount`, and each passed card shifts by one rank. Layout from ranks is `top[card] = paddingTop + Σ over other cards of sizeY[other] · [rank[other] < rank[card]]`. Because sizes are static data, each term is a constant times an exact integer bit (`relu(d) − relu(d − 1)`), not a multiply.

`cards-rank.ts` checks the formula against a transcription of the demo's while loops, on random orders, dragged cards and pointer positions:

| Cards | Trials | Disagreements with the swap loop | Layers | Live operations | Stored weights |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 3,000 | 0 | 10 | 147 | 320 |
| 20 | 3,000 | 0 | 10 | 1,182 | 3,080 |
| 50 | 300 | 0 | 10 | 5,952 | 16,700 |
| 100 | 300 | 0 | 10 | 21,902 | 63,400 |

Depth stays at 10 layers for any card count. Weights grow as n² because every card compares its rank with every other card. A rank vector is also cheaper than a permutation matrix for this: moving one item costs O(n) comparisons plus the O(n²) layout, where the IndirectOS permutation update costs O(n³) products.

### 4. Threshold counts instead of sqrt, floor and runtime division

life-calendar's grid sizing solves a quadratic with `Math.sqrt`, divides by the runtime block size, floors, and ceils (grid-sizing.ts:4-12). The root b satisfies `(gx / b + 7) · (gy / b) = life`, and `countX >= 7m` holds exactly when `life · gx >= 49 · m · (m + 1) · gy`. So `countX / 7` is a count of linear threshold tests with constant coefficients. `countY = ceil(life / countX)` and `1 / countY` are constants for each candidate, so they are affine in the one-hot of the count.

`life-grid.ts` with 140 candidates found 0 mismatches in countX and countY against the demo over 197,232 viewports from 320×320 to 3840×2160. The largest block size relative error is 1.1e-7. It uses 15 layers, 1,980 live operations and 3,386 stored weights.

The same reformulation applies to the photo gallery's column count. `cols = clamp(1, floor((width − 24) / 244), 7)` (layout.ts:110) becomes six tests `width − 24 >= 244m` against exact integers. The trace compiler README reports that its reciprocal-based floor picks one column too few at widths 512, 756, 1000, 1244, 1488 and 1732. Those are exactly the widths `24 + 244m`, and the threshold form has no reciprocal to round.

### 5. Text height as a step function of width

pretext line breaking can't run in the circuit, but only its numeric result feeds geometry. With greedy line breaking the line count should never increase as the width grows. If that holds, a prepare step can emit each text's breakpoint widths once, and the circuit computes `lineCount = linesAtNarrowestWidth − Σ [width >= breakpoint]` at any width, including animated widths. `text-staircase.ts` uses the pretext copy with the deterministic fake canvas from pretext's test suite (fixed per-character widths, so real fonts will move the breakpoints):

| Texts | Width range | Widths where the line count increased | Breakpoints: median / max / total |
| --- | --- | ---: | --- |
| 221 photo-gallery prompts | 16..2000 | 0 | 16 / 45 / 3,875 |
| same prompts, counting only changes of min(lines, 2) | 16..2000 | 0 | exactly 1 per prompt, 221 in total |
| same prompts, counting only changes of min(lines, 3) | 16..2000 | 0 | exactly 2 per prompt, 442 in total |
| 251 comments of the demo's HN thread (91,301 characters) | container 375..1200 | 0 | 4 / 149 / 1,833 |

The gallery caps captions at 2 lines in the grid and 3 lines in the line view (prompt-layout.ts:12-17), so a caption's height at any width costs one or two comparisons per photo. The circuit does not produce the line text itself. When DOM text must be rendered at an animated width (photo-gallery index.ts:635-652), JS still materializes the lines.

### 6. Bounded runtime division

Three demos estimate pointer velocity as a distance divided by a runtime time difference (draggable-cards index.ts:189-196, gesture-flick-snap-target index.ts:208-219, mobile-test-standalone index.ts:379-382). The README TODO says to revisit dynamic division "only when a real UI needs it", and these demos need it. `division.ts` picks a seed reciprocal from 11 power-of-two threshold buckets over 0.25..256 ms (relative error at most 1/3), then runs Newton steps `r ← r · (2 − dt · r)`:

| Newton steps | Largest relative error of the reciprocal | Layers | Live operations | Stored weights |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 1.5e-4 | 24 | 165 | 247 |
| 4 | 1.6e-7 | 27 | 168 | 252 |

### 7. Two superposed springs are one spring

gesture-flick-snap-target renders `spring1 + spring2 − restPos` (index.ts:128-131). Spring 1 carries the flick from the release position toward the decay rest position, and spring 2 moves from the rest position toward the corner (index.ts:137-156). Animation.md:88 speculates that an equivalent single spring might exist. Both springs use the same constants and each step is linear, so the sum is exactly one spring that starts at the release position with the flick velocity and targets the corner. The rest position only decides which corner. `superposition.ts` found a largest difference of 0.010 px before any settle snap, and 0.016 px including each spring's settle snap, over 2,000 flicks × 400 frames. A circuit port can store one spring per axis instead of two.

## Per demo

### draggable-cards

What it does: five rows with random heights (30..180 px), stacked and centered. Dragging a row reorders the list. The dragged row follows the pointer, with horizontal motion pulled toward the center, and scales to 1.1 with a larger shadow and 0.7 opacity, while the other rows spring into their new slots. On release the row keeps its flick velocity and springs into place.

Algorithms:
- Event recording into a pointer ring buffer of up to 20 samples (index.ts:157-176, 275-276).
- Hit test against the current animated spring positions, first match in data order (index.ts:146-152, 200-202).
- Grab offset on the first down; while dragging, both `pos` and `dest` are pinned to the pointer (index.ts:209-213, Input.md "Pinning Springs During Drag"). The horizontal position is `x + (center − x) / 1.5`.
- Swap loops against the neighbors' previous destinations (index.ts:215-223, swap-layout.ts:16-22).
- Stack layout prefix sum (swap-layout.ts:29-40, index.ts:225-235).
- Release velocity from the samples of the last 100 ms, added to the spring velocities (index.ts:186-196).
- Fixed 4 ms springs with catch-up of up to 300 steps and settle snapping (index.ts:242-250).
- Z-index bands: dragged row, last released row, then data order (index.ts:256-259). `lastDragged` is set on release (index.ts:272) and stays set until the next release; Input.md suggests clearing it once the row settles.

State: the data order (a permutation); three springs per row (x, y, scale) with position, destination and velocity; the dragged id and grab offset; the last dragged id; pointer state (up, first down, down); the pointer ring buffer; `animatedUntilTime`.

Animation: numeric springs with k=290 b=24, destinations pinned during drag, velocity injected on release.

Computational shape: first-match hit test; one insertion step of a sort by adjacent swaps; prefix sum; per-item map; gesture velocity estimation (window search plus division); springs.

Circuit sketch:
- Source table: viewport width; pointer latches (down, move, up) with x, y and event time; 20 ring buffer samples (x, y, time) and a sample count; drag active bit, dragged one-hot (all zero when idle), grab offset (2); last dragged one-hot; a rank per card; 5 cards × 3 springs × (displacement, velocity); leftover clock milliseconds. Row heights are compile-time coefficients.
- In the circuit: rectangle hits against current positions with priority by rank (an argmax over `hit · (1 − rank / n)`, or a first-match over hits reordered through the rank one-hots); grab offset; rank counting and layout (reformulation 3); springs as matrix powers with destinations pinned during drag; release velocity via a first-match over `[releaseTime − sampleTime <= 100]` in the ring buffer, a gather of that sample, and the bounded division (reformulation 6); ring buffer shift (one select per cell); z band codes and a cursor code (auto, grab, grabbing).
- In JS: event wiring (mouse and touch sources merged into the latches), transform strings, picking shadow and opacity strings from the dragged bit, the cursor string.
- Hardest part: the release velocity (a window search over unevenly spaced timestamps plus a runtime division), then the O(n²) layout cost past a few dozen cards.

### gesture-flick-snap-target

What it does: a 120×80 picture-in-picture box that you drag and flick. On release it projects where exponential decay would stop it (`pos + v / 4.5`), picks the nearest of four corners, and animates there. A marker shows the projected rest position.

Algorithms:
- The current position is `spring1 + spring2 − restPos` (index.ts:128-131), and the hit test uses it (index.ts:132-135).
- Pointer down starts dragging with an offset (index.ts:180-188); pointer moves update the position and the history (index.ts:191-196).
- Release: velocity over the last 100 ms (index.ts:208-219), then `triggerSnap` (index.ts:137-156) with `decayRestPos` (snap-layout.ts:42-44) and `nearestCorner`, an argmin of squared distance (snap-layout.ts:26-35).
- Springs step only while idle (index.ts:227-239).

State: mode (idle or dragging); four springs; rest position; drag offset and drag position; pointer history of up to 20 samples; marker visibility; `animatedUntilTime`.

Animation: two superposed numeric springs with k=290 b=24.

Computational shape: gesture velocity estimation; closed-form decay projection; argmin over snap targets; superposition of linear systems.

Circuit sketch:
- Source table: viewport width and height; pointer latches with x, y and time; mode bit; drag offset (2) and drag position (2); history ring (20 × 3) plus a count; one spring per axis (displacement, velocity, destination), since reformulation 7 removes spring 2; rest position (2) for the marker; marker bit; clock.
- In the circuit: corners are affine in the viewport size. The nearest corner separates by axis because the four corners are the Cartesian product of two x values and two y values: `cornerX = select([restX > (leftX + rightX) / 2], leftX, rightX)`, and likewise for y. Ties go to the left and top, which matches the demo's strict `<` over corners ordered top-left, top-right, bottom-left, bottom-right. The decay projection is affine. Velocity uses the bounded division. Springs use matrix powers. The cursor is a code.
- In JS: event wiring, the transform string, the marker's display string.
- Hardest part: the division and the window search. Everything else is a few hundred operations.

### life-calendar

What it does: draws every day of a 75-year life (27,393 days) as a canvas grid. The column count is a multiple of 7 and the block size fills the viewport. Days before today are filled, weeks entirely before or after today are drawn as pills, the hovered dot gets a color from a hash, and clicking toggles a custom dot with an editable goal tooltip saved to localStorage.

Algorithms:
- `gridSizing` (grid-sizing.ts:4-12) and the floor-division hit test (grid-sizing.ts:19-34).
- Custom dot toggle and cursor (index.ts:126-133).
- The canvas draw loop with week pills (index.ts:151-175), hovered, custom and last dots (index.ts:185-196), column lines (index.ts:198-204).
- Tooltip position, mode and text (index.ts:207-221); focus and localStorage side effects (index.ts:230-232).

State: custom dot index or null, custom dot text, pointer, pointer state, event latches.

Animation: none.

Computational shape: closed-form sizing with sqrt, runtime division, floor and ceil; a 2D grid hit test; a per-cell map over 27,393 cells; string state.

Circuit sketch:
- Source table: viewport width, height and devicePixelRatio; pointer x and y; click latch; custom dot index and present bit. `life` and `age` are compile-time constants.
- In the circuit: grid sizing as threshold counts (reformulation 4, measured). Grid offsets are affine. The hovered row is a thermometer count `Σ_r [pointerY >= r · blockSize]`; since `r` is a constant, each threshold is affine in `blockSize`, and columns work the same way. At 1440×900 that is about 130 row tests and 210 column tests, and the capacity must cover the largest supported viewport. The hovered index is `row · countX + column` (one product). Then inside-grid bits, equality bits against `age`, `life − 1` and the custom dot, the toggle, the cursor code, the tooltip position and a tooltip mode code.
- In JS: painting 27,393 cells, the tooltip `<input>` and its strings, localStorage, and the hover color hash (`lowbias32` uses integer multiply and xor; a table of 27,393 precomputed hashes read by the hover one-hot would also work).
- Hardest part: the per-cell painting. It is a per-instance map at a scale where duplicating operations per instance breaks down, so it needs an executor with an instance axis, the way a shader runs one program per pixel.

### spring-comparison

What it does: three pairs of dots. A Fling button sends each pair to seeded random positions. One dot of each pair uses the numerical spring (6 ms steps, k=333 b=12), the other uses the closed-form underdamped spring, and the page shows how far apart they drift.

Algorithms: `springStep` (index.ts:36-41); the closed-form constructor and sampler with exp, cos and sin (index.ts:70-83); retargeting by sampling position and velocity, then rebasing (index.ts:91-98); random destinations with `hash2` (index.ts:178-191); fixed-step catch-up (index.ts:194-203); settle checks (index.ts:207-215); divergence text (index.ts:223-234).

State: per pair, two numeric springs and two closed-form springs (destination, A, B, start time); retarget count; `animatedUntilTime`.

Animation: both methods side by side.

Computational shape: closed-form function of time; fixed-step integration; integer hashing.

Circuit sketch:
- Source table: viewport; click latch; retarget count; for each pair, axis and method: displacement, velocity, destination; clock.
- In the circuit: the numeric lane uses Euler matrix powers and the closed-form lane uses exact matrix powers, which sample the analytical curve at multiples of the step (reformulation 2). To sample between steps, carry the leftover milliseconds in state or use a finer step (1 ms steps need 11 stages to cover 1200 ms). Retargeting is `displacement += oldDestination − newDestination`.
- In JS: `hash2` destinations on click, written into the source table as input; the divergence text.
- Hardest part: nothing structural. The demo mainly shows off the matrix power construction, which every other demo with springs can use.

### predictive-keyframes

What it does: images load progressively and spawn at the center at intervals. Boxes push each other apart by overlap area, shrink near the viewport edges, and fade out and get removed when they reach an edge. The render loop deliberately runs only every 300 ms. Each render simulates 1200 ms ahead and hands the frames to Web Animations, so motion stays smooth.

Algorithms:
- `overlapArea` (index.ts:50-55), `boxHeight` as width divided by aspect ratio (index.ts:68-71), `calculateRepulsion` with a sqrt distance and remap (index.ts:164-183), `minEdgeDistPct` (index.ts:185-194).
- `simulate` (index.ts:196-261): spawning with a countdown (203-222), pairwise forces (224-234), integration with velocity multiplied by 0.2 per step (236-243), the scale destination `1 − (0.9 − max(0, minDist))^10` (246), springs (247-250), exit (253-256), removal (259).
- Keyframe padding with `display: none` (index.ts:288-306); render cancels previous animations, catches up, predicts 201 steps and starts animations (index.ts:325-386); the 300 ms scheduler (index.ts:312-321).

State: world (next image index, box list, spawn countdown); per box: image job, width, center, velocity, opacity and scale springs, enter progress, exiting bit; `animatedUntilTime`; DOM cache with Animation objects.

Animation: fixed 6 ms world steps, and prediction by repeated calls to `simulate`.

Computational shape: pairwise N-body interaction; dynamic population; integer powers; per-step integration; prediction by iterating a pure step function.

Circuit sketch:
- Source table: viewport; spawn countdown and next image index; the next job's aspect ratio and aesthetic bit (JS writes them once an image finishes loading); a fixed capacity of box slots, each with present bit, image index, width, reciprocal aspect ratio, aesthetic bit, center (2), velocity (2), two springs, enter progress and exiting bit. Boxes leave at the edges, so the live count is bounded by the spawn and exit rates; 32 slots is a guess to measure.
- In the circuit: one `simulate` step. Spawn into the first free slot (first-match over present bits). Pairwise overlap areas (n² pairs of min, max and one product). The repulsion direction `dx / dist` needs sqrt and division; either push along the axis of least penetration (no sqrt, but a behavior change) or normalize with a bounded reciprocal square root built like reformulation 6. The 10th power is four products by repeated squaring. Springs; the exit bit; removal clears the present bit once opacity reaches 0.
- In JS: image loading, keyframe strings, iterating the circuit 201 times per render, DOM nodes.
- Hardest part: the pairwise interaction with sqrt and division in every pair, and 201 evaluations per render. At IndirectOS's measured 32 µs per evaluation for about 5,000 operations, 201 evaluations take about 6.4 ms. Animation.md:136-138 requires `simulate` to be pure so predictions can be thrown away, and a circuit is pure by construction.

### scroll-anchor

What it does: a scrollable feed of cards grouped under day headers, with buttons to scroll to 700 px, add three items above, or add items in two rapid updates. When items are prepended, the visible content doesn't move, because scrollTop is adjusted to keep an anchor item in place.

Algorithms:
- `computeAnchorLayout` (anchor-layout.ts:84-139): a prefix sum with header gaps for each run of items with the same day. When the user scrolled, the first item below scrollTop becomes the new anchor (116-118); otherwise scrollTop shifts by how far the anchor moved (120-123).
- User scrolling is detected by comparing scrollTop with the stored read-back value (index.ts:111), then the anchor is committed (index.ts:123-127).
- Occlusion culling for headers and items (index.ts:134-171); `scrollTo` followed by a read-back (index.ts:181-192).

State: id counter; items (id, day, label, color); anchor (id, previous y); stored scrollTop; event latches.

Animation: none.

Computational shape: prefix sum over runs of equal keys; first-match search; identity lookup by id; a side effect with read-back.

Circuit sketch:
- Source table: a capacity of item slots, each with present bit, session start bit, first-in-session bit (JS computes these from the day strings when data changes) and a numeric id; current scrollTop, stored scrollTop, requested scroll latch and value, viewport height; anchor id, previous y and present bit.
- In the circuit: item y from a one-layer prefix sum (reformulation 1) over per-slot heights `100 + 8 · notFirstInSession + headerBlockHeight · sessionStart`. Every coefficient is a constant and the bits come from data, so the sum stays affine. "User scrolled" is an equality bit between two scroll values. The new anchor is a first-active over `[y > scrollTop]`. Looking up the stored anchor compares its id with each slot's id, giving a one-hot that gathers y. The adjusted scroll is `scrollTop + y − previousY`, gated by "not user scrolled", "anchor present" and `scrollTop > 40`. Visibility bits per slot.
- In JS: making ids and day strings, prepending (rewriting the slots), DOM nodes, `scrollTo` and reading scrollTop back.
- Hardest part: identity. The anchor is an id, while prepending shifts every slot. Either every frame pays n id comparisons, or items keep stable slots with an order rank so prepending only rewrites ranks (then y needs rank-ordered heights, as in reformulation 3). The browser's scrollTop truncation (Scrolling.md) still applies to the circuit's scroll output.

### photo-gallery

What it does: 221 AI-generated images with prompts. A responsive grid of 1 to 7 columns sizes images by area rather than width and shows 2-line captions. Clicking an image opens a horizontal line view with the focused image centered and its neighbors smaller, dimmer and blurred. Arrow keys navigate with edge rubber banding, and Escape returns to the grid and scrolls back to the image. It also has a hover magnet, anchoring during resize, residual springs for transitions, occlusion culling, prompt selection, and routing through the URL hash.

Algorithms:
- Grid: `colsBoxMaxSizeXF` (layout.ts:106-116); maximum image height by aspect ratio (layout.ts:118-126); `measureGridImage` min chain (layout.ts:146-158); `getGridLayout` with a running row max and a row prefix sum (layout.ts:165-228).
- Line view: `getLineLayout`, a backward prefix sum from the focused item and then a forward one (layout.ts:251-303, the backward loop at 262-263); `get1DItemSize`, a fixed-point loop between caption height and image size (layout.ts:345-367).
- Captions: the pretext line walk (prompt-layout.ts:81-111).
- index.ts: residual rects, where the base value jumps and a spring residual carries the visual difference back to 0 (153-166, 236-251); focus from the URL hash (416-419); keys (449-454); hit tests (396-406); transition flags (477-484); grid positions, hover magnet and anchor search (491-534); line view with rubber band velocity (535-569); scroll shift preserved through residuals (570-573); springs (576-587); occlusion and just-in-time DOM, including re-measuring captions at the animated width every frame (598-671, captions at 635-652); z-index (654-662); selection, scrollTo and pushState (678-695).

State: per item, a layout rect and a caption rect with four residual springs each, plus scale and effect springs, so 10 springs per item and 2,210 springs in total; anchor index; last window width; scrollY; pointer; event latches; the focus in the URL hash.

Animation: residual springs with k=290 b=30 that settle to 0. Base values jump, and residuals are only set when the transition flags say a change should animate.

Computational shape: bounded structural choice (column count 1..7); per-row max; prefix sums; a bounded fixed-point iteration; first-match anchor search; per-item map; text measurement at animated widths; occlusion.

Circuit sketch:
- Source table: viewport width and height; scrollX and scrollY; pointer; click and key latches (left, right, Escape); a focused one-hot over 221 slots, or an index plus a present bit; previous window width; anchor index; per item static aspect ratio and natural width (compile-time coefficients); per item caption breakpoints from pretext (1 for the grid, 2 for the line view, reformulation 5); 221 items × 10 springs × (displacement, velocity) = 4,420 cells.
- In the circuit: column count by threshold tests (exact at the boundaries); row assignment specialized for each column count and selected by the column one-hot (the trace compiler did this for an earlier revision of the gallery with the same 221 photos and reported 24,894 operations and 600 layers for the 2D slice); row max via `emitMaximum` trees over at most 7 items; row tops via one-layer prefix sums; line-view left positions via sums of widths masked by `[j < focused]`; `get1DItemSize` unrolled for a few iterations (caption height takes at most 4 values; whether the loop always settles within 3 iterations is unchecked); residual updates when layout changes (affine, selected by the transition flags); springs as matrix powers; hover magnet; anchor search; visibility bits, with bounded visibility compaction into a fixed number of DOM slots (tricks.md:76-84, still untested).
- In JS: pretext prepare and caption line text at the current width; image source swapping; selection; URL hash and pushState; scrollTo; the reduced-motion media query as a latch.
- Hardest part: scale. Springs alone would be 221 × 10 × 81 ≈ 179,000 operations with the matrix power construction, each one-layer prefix sum over 221 items stores about 24,750 weights, and captions still need JS string work every frame while widths animate.

### nicer-hacker-news

What it does: a reimplementation of an HN thread (251 comments in the displayed thread, indents 0..10) with layout owned by JS. Comments are laid out with pretext into absolutely positioned lines. The submission header compresses as you scroll. Pressing on a gutter reveals the ancestor comment by shrinking the rows between that ancestor and the pointed row. It also has custom text selection with HTML copy, fuzzy in-thread search highlighted on a canvas, canvas gutters, and scroll smoothing.

Algorithms:
- Parsing: `parseHNCommentHTML` through a DOM template, with run merging and whitespace normalization (hn-comment-parser.ts:14-64, 157-178, 201-203).
- Text: `prepareHNCommentDoc` (hn-comment-layout.ts:74-94); `layoutPreparedHNCommentDoc`, per paragraph, with fragment text offsets (hn-comment-layout.ts:96-241); text offset and rect lookups for selection and search (hn-comment-layout.ts:337-455, prefix width measurement at 507-519).
- Thread geometry: row prefix sums (hn-thread-layout.ts:67-92, 94-180), the sticky user header clamp (116-117), the gutter extent over contiguous descendants (132-136), the visible range (138-144).
- index.ts: scroll smoothing (286-303); per-row layout cached by width (314-326); header sizing as piecewise functions of scrollTop (329-366); the pointed row and the gutter ancestor walk (371-397); shrink flags (404-413); peek-up easing (415-434); height easing `height += (target − height) / 5` (437-450); visual geometry (453-469); two DOM passes (507-609); selection with `caretRangeFromPoint` (626-708); cursor and link opening with `elementFromPoint` (710-728); regex search (730-739); highlight rects (740-808).

State: per row: static indent, prepared document, cached layout and its width, grow or shrink flag, eased height; pointer inputs and the down target; scroll smoothing state; peek-up offset; selection (DOM nodes, offsets, row, Range).

Animation: easing by frame count rather than time-based springs, so its speed depends on the frame rate; scroll smoothing blends 0.55 of the previous value with 0.45 of the real scrollTop.

Computational shape: string parsing; text layout; tree walks over indents; prefix sums; a first-match ancestor walk; per-frame exponential easing; piecewise linear scroll-driven header; DOM-bound selection and hit testing.

Circuit sketch:
- Source table: viewport; smoothed scrollTop and previous delta; real scrollTop latch; pointer x, y and state; per row (capacity 251) text breakpoints or text height, eased height, shrink bit; peek-up offset. The static indents become compile-time tables: `subtreeEnd[i]`, the first following row whose indent is less than or equal to row i's, and `ancestor[i][d]` for d in 0..10.
- In the circuit: container width clamp; comment heights from breakpoints (reformulation 5, 1,833 tests for this thread); row tops via a one-layer prefix sum over eased heights (about 31,600 weights). The pointed row needs no search because row bottoms are sorted: `row = Σ_i [pointerY >= bottom[i]]`, one thermometer count. The pointed indent is a count of 24 px steps. The gutter test is `[indentPointed <= indent[row]]`. The ancestor is `Σ_i rowOneHot[i] · (Σ_d indentOneHot[d] · ancestor[i][d])`; the inner sum has constant coefficients, so the whole lookup costs 251 products. Shrink bits are `[ancestor < i] · [i < row]` from integer comparisons. Target heights and easing are affine. Gutter bottoms reference `top[subtreeEnd[i]]` directly, so the loop at hn-thread-layout.ts:132-136 becomes wiring. Sticky header clamps, submission header piecewise functions, visibility bits.
- In JS: HTML parsing; pretext prepare and line materialization (only when the width changes, already cached); DOM nodes; selection (`caretRangeFromPoint`, Range, clipboard); `elementFromPoint` for links and `window.open`; regex search producing match rects relative to the comment (the circuit only adds row offsets); canvas drawing.
- Hardest part: selection and link hit testing go through DOM APIs, so the circuit only helps with geometry. Long comments have up to 149 breakpoints, which competes with simply recomputing heights in JS on resize.

### mobile-test-standalone

What it does: a mobile-first prototype of an image generation feed with 6 jobs of 2 to 4 images, prompt headers and a composer input. It has three views: the regular feed (images in 1, 2 or `count` columns, chosen by area), collapsed (a small rotated stack of the last three jobs above the composer), and a lightbox (a horizontal strip of every image with the focused one large). It supports touch swipes with direction lock and flick velocity, keyboard navigation, and a hover tilt.

Algorithms:
- Springs at 6 ms, k=333 b=33 (index.ts:12-19); fit, remap and overlap helpers (index.ts:30-51).
- `colsF` picks 1, 2 or `count` columns by the largest total image area (index.ts:95-107).
- `prevFocus` and `nextFocus` across job boundaries (index.ts:243-252); hit tests over destination rects (index.ts:280-318).
- render: keys (348-361); pointer events sorted by priority (365); touch processing with velocity over 40 ms (370-395) and direction lock `|dx| · 1.7 > |dy|` (390-393); view transitions (407-456); row tops prefix sum (462-470); regular view with hover and anchor row (476-527); lightbox strip lefts using the focused size and a 160 px gap between jobs (537-545), the flattened focus index (547), the centering offset (548), rubber band velocity (550-551), touch drag offsets (555-557), header follow (581-588); collapsed view with rotation remap (593-620); springs (623-631); DOM writes with modular z-index arithmetic (644-668); scrollTo and input blur (674-675).

State: the view as a tagged union (regular; collapsed with saved scrollTop; lightbox with row, count and saved scrollTop); anchor row; touch down (x, y, time, scroll lock); previous inputs ring; per job header springs; per image springs (x, y, sizeY, rotation); container width; previous scrollTop; previous innerHeight (keyboard detection); first render flag.

Animation: springs; velocity injected on touch release (index.ts:490, 577).

Computational shape: a state machine over a tagged union; a small argmax over 3 candidates; prefix sums; flattening a 2D index; direction lock; velocity estimation with division; modular z-order.

Circuit sketch:
- Source table: viewport and container rect; composer size; input-focused bit; key latches; pointer latches with priority (up before down before move, as at index.ts:365); touch down (x, y, time, lock code, present bit); previous input ring; view one-hot (3 values), lightbox row one-hot (6), image one-hot (4), saved scrollTop; anchor row one-hot; 22 images × 4 springs × 2 cells; 6 headers × 2 springs × 2 cells.
- In the circuit: `colsF` as an argmax over 3 area candidates (each a min of two affine rows, then a product); row tops; image positions for each view, specialized for 1, 2 or `count` columns (the counts are static data) and then selected; lightbox lefts as a one-layer prefix sum over the flattened images, with the focused size selected; previous and next focus as one-hot shifts over the flattened sequence (like Photos in photo-gallery.ts:418-429); the direction lock comparison; release velocity via bounded division; springs; z-index codes, where `(3 − count + j) % 4` is a static table over (count, j).
- In JS: touch and mouse wiring, input focus and blur, standalone detection, scrollTo, image sources, header heights (measured with `getBoundingClientRect` at startup, index.ts:224).
- Hardest part: the tagged-union view with its nested payload, and the rules for restoring the saved scrollTop (index.ts:407-456, 499-517). Each branch is cheap, but there are many of them to author.

### global-illumination-fast-approx

What it does: Alex Evans-style screen-space lighting over a 5×4 image grid. The rects are rasterized into a half-resolution canvas and uploaded as a mipmapped texture. One fragment shader computes sky occlusion and bounce light by sampling that texture at increasing mip levels above and below each pixel, and adds a cursor light with a soft shadow marched toward the cursor.

Algorithms: rounded rect rasterization (index.ts:22-46); mip blur shader (index.ts:95-117); lighting shader with 13 sky taps (132-136), 25 cursor shadow taps (145-148), and bounce and wide taps (149-157); texture upload and mip generation (index.ts:211-259); one draw per render (index.ts:261-270); grid layout (index.ts:337-374).

State: rects, cursor, a dirty flag, GL objects.

Animation: none; it redraws when the cursor moves.

Computational shape: a per-pixel map with fixed-count loops; texture lookups at mip levels; `pow`.

Circuit sketch:
- The texture can be replaced with analytic coverage. The coverage of an axis-aligned rect under a box filter of radius r is a product of two 1D overlap ramps, `clamp((min(x + r, right) − max(x − r, left)) / 2r, 0, 1)`, which is relu, min, max and a constant scale. A sky tap becomes a sum over the 20 rects of those products (ignoring rounded corners), and the sky shadow is a product over 13 taps of `(1 − density · coverage)`. `pow(x, 1.2)` and the gamma curve need approximations (piecewise linear or a table), and `0.07 / (dot + 0.075)` needs a bounded reciprocal (reformulation 6).
- In the circuit: the grid layout (affine per cell) is trivial and could feed the shader.
- Hardest part: per-pixel execution. Half resolution of 1440×900 is 324,000 pixels, each with thousands of operations. Duplicating operations per pixel doesn't work, so this needs an executor that applies one per-pixel circuit to a batch of pixels.

### global-illumination-pathtracer

What it does: stochastic 2D ray tracing. Each pixel shoots one random direction per frame and marches through the mipmapped scene texture with quadratically growing steps. On a hit it estimates a normal from occupancy gradients and reads albedo and incoming light from the direct lighting texture. Results accumulate across frames with R2 quasi-random noise, followed by an edge-aware denoise, a direct light pass and tone mapping.

Algorithms: noise texture via hash (index.ts:17-29); tone mapping composite (index.ts:93-107); mip blur (110-132); 17-tap edge-aware denoise (135-181); 48-tap direct light toward the cursor (184-210); GI march of up to 128 steps with early exit (213-260); accumulation alpha policy (557-576, 632-635); scene rects read from the DOM with `getBoundingClientRect` (425-428).

State: GL textures (GI accumulation, denoise, direct light), frame count, accumulation counters, cursor, last cursor move time.

Animation: progressive refinement, with per-pixel feedback through textures.

Computational shape: per-pixel Monte Carlo with data-dependent early exit; per-pixel temporal state; normalize and reflect (sqrt and division).

Circuit sketch: the early exit becomes 128 masked iterations that all run; random directions come from hashing outside the circuit; per-pixel accumulation state would be millions of source cells. This demo is the far end of the shader half of the inspiration. It would test an instance axis and texture state, not UI logic.

## Patterns across the demos

| Pattern | Where | Status as a circuit |
| --- | --- | --- |
| Fixed-step spring with catch-up and settle | every animated demo | Expressed today with runtime-timestep substeps; matrix powers match the fixed-step guidance (reformulation 2) |
| Closed-form spring sampled at a timestamp | spring-comparison index.ts:74-98 | Exact matrix powers, measured |
| Stack layout (prefix sum) | swap-layout.ts:29-40, anchor-layout.ts:84-139, hn-thread-layout.ts:67-180, layout.ts:198-206, mobile-test index.ts:462-470 | One `roundAffine` row per output: depth 1, n²/2 weights, measured bit-identical |
| Reorder by drag | draggable-cards index.ts:215-223 | Rank counting: 10 layers, n² weights, measured |
| Pointer velocity over a time window | draggable-cards index.ts:186-196, flick-snap index.ts:208-219, mobile-test index.ts:379-382 | Needs a first-match over a ring buffer plus a runtime division; division measured |
| Nearest snap target | snap-layout.ts:26-35 | Separable per axis for grid-aligned targets; otherwise `emitArgmax` |
| Column count by floor and clamp | layout.ts:106-116, grid-sizing.ts:4-12, mobile-test index.ts:95-107 | Threshold counts, exact; measured for life-calendar |
| Row max | layout.ts:198 | `emitMaximum` tree |
| First match (hit test, anchor, ancestor) | draggable-cards index.ts:146-152, anchor-layout.ts:116, photo-gallery index.ts:529-534, HN index.ts:389 | `emitFirstActive`, or a thermometer count when the sequence is sorted |
| Tree structure | hn-thread-layout.ts:132-136, HN index.ts:389 | Compile-time tables and wiring when indents are static data |
| Text height at a width | prompt-layout.ts:81-127, hn-comment-layout.ts:96-241 | Breakpoints from a JS prepare step, threshold bits in the circuit; measured monotone |
| Residual animation | photo-gallery index.ts:153-166, 236-251 | Affine updates selected by transition flags |
| Easing by frame count | HN index.ts:431, 446 | Affine per frame (depends on frame rate, like the original) |
| Tagged-union view state | mobile-test index.ts:160-163, photo-gallery focus from the hash | One-hot mode plus payload one-hots |
| Event priority within a frame | mobile-test index.ts:365, photo-gallery index.ts:449-474 | Latches with `emitFirstActive` priority |
| Pairwise interaction | predictive-keyframes index.ts:224-234 | n² pairs; sqrt and division need new constructions or a changed force law |
| Dynamic population | predictive-keyframes index.ts:203-222, 259 | Capacity plus present bits, first free slot |
| Prediction loop | predictive-keyframes index.ts:345-351 | JS iterates the circuit |
| Per-cell and per-pixel maps | life-calendar index.ts:151-175, both GI demos | Need an instance axis in the executor |
| Strings, DOM queries, side effects | parsers, selection, regex search, localStorage, pushState, scrollTo, focus | Outside the circuit; results enter as numbers |

## Ranking: what to port next

1. photo-gallery. The first real-size content app: 221 items, a bounded structural choice, row reductions, prefix sums, captions, residual springs and anchoring. It tests whether the approach reaches a real app, and it has a baseline, since the trace compiler already compiled slices of an earlier revision (24,894 operations and 600 layers for the 2D slice, 1,580 layers for the 1D slice). A hand-authored port with one-layer prefix sums, threshold column counts, caption breakpoints and matrix power springs would show how far those numbers drop, where per-item duplication starts to hurt (about 179,000 spring operations), and whether bounded visibility compaction works for DOM slots. Selection, routing and image loading stay in JS.
2. draggable-cards. Small but complete: permutation state, the reorder formula, pinned springs, release velocity with a real division, and z-order bands. Running it at 5, 20 and 100 cards would show where O(n²) comparisons hurt in a live frame, and would settle rank vectors versus permutation matrices as the state representation for list apps.
3. nicer-hacker-news thread geometry. Tree layout with static structure as wiring, text breakpoints at real content scale (1,833 tests for one thread), ancestor lookups, and peek easing. The port would show whether tree features reduce to tables plus arithmetic, and exactly where text features (selection, search) must leave the circuit.
4. gesture-flick-snap-target. The smallest complete gesture: velocity division, decay projection, the separable corner choice, and one spring instead of two. It is the quickest way to put division in a live UI; draggable-cards covers the same velocity problem if only one of the two gets ported.
5. predictive-keyframes. The circuit as the pure `simulate` that Animation.md asks for. It would measure 201 evaluations per render, a dynamic population with capacity and present bits, and pairwise interaction with sqrt. It connects to "Candidate futures" in ideas.md.
6. scroll-anchor. Identity versus slot index when items are inserted. Every feed that receives new items above the viewport needs this, and the port is small.
7. mobile-test-standalone. Touch direction lock and a nested view state machine. It overlaps with IndirectOS Photos, so it teaches less that's new.
8. life-calendar. The sizing reformulation is already verified. What remains is the per-cell map, which is really a question about adding an instance axis to the executor.
9. spring-comparison. The construction is verified; porting the demo adds little beyond a visual check.
10. The two global illumination demos. Worth porting only once an executor with an instance axis exists; they test the shader half of the inspiration rather than UI logic.

## What I didn't check

- Text breakpoints were measured with pretext's fake per-character widths. Real fonts will move the breakpoints, so monotonicity should be rechecked in a browser.
- Whether `get1DItemSize` (layout.ts:345-367) always settles within a small fixed number of iterations.
- Executor timing for large one-layer prefix sums; only sizes were measured.
- The first-match window search for velocity estimation was not built; only the division was.
- The comparison helpers in my scripts use two scale-and-clamp stages that assume the smallest meaningful positive difference is at least 2^-14 and values stay below 2^17. The production sign cascade (tricks.md) handles any finite difference and costs more operations.
