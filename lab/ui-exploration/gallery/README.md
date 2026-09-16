# Photo gallery as one circuit

This folder hand-authors the render path of chenglou.github.io's photo gallery, 221 photos, as one Indirect circuit. It checks the circuit against the original `index.ts` running natively, and compares its size with the trace compiler's slices of the same file and with IndirectOS.

Update, September 15, 2026: window-manager.ts moved to host-timed springs, so the row for scale in `report.ts` measures the pre-change IndirectOS from codegen's `window-manager-copy.ts`.

## What it is and how to run it

The source is the frozen fixture `lab/trace-compiler/fixtures/index.ts.txt` (gallery commit f315d586). One circuit evaluation is one call of index.ts's `render(now)`. It reads the viewport, the scroll position, the photo focused in the URL, event latches and the committed state. From those it computes the new focus, the 2D grid or 1D strip destinations, hover, the scroll anchor, every spring, occlusion bits, and the next committed state. JS keeps the DOM reads, the id lookup in the URL hash, DOM nodes and style strings, `scrollTo`, `pushState`, and the DOM Range for prompt selection.

From the repo root:

- `bun test lab/ui-exploration/gallery` runs 16 tests in about 2.5 seconds.
- `bunx tsgo -p lab/ui-exploration/gallery` typechecks the folder.
- `bun lab/ui-exploration/gallery/report.ts` prints every measurement below and writes `report-output.json`. It takes about 70 seconds.
- `bun lab/ui-exploration/gallery/demo.html` serves the browser demo. The photos aren't stored locally (the site loads them from Midjourney's CDN), so boxes are colored rectangles with each photo's aspect ratio. Add `?photos=cdn` to load the originals. I checked that the demo bundles with `bun build`, but I haven't opened it in a browser. A later Chrome check opened the demo, see [Browser check](#browser-check).
- `bun lab/ui-exploration/gallery/prepare-captions.ts` regenerates `caption-breakpoints.json`. It needs a copy of pretext's `src/`, named by `PRETEXT_SRC`; the session scratch copy it ran with isn't in the repo, and `lab/ui-exploration/text-tabulated/pretext/` holds the same files.

Files:

- `gallery-circuit.ts`: the circuit builder, one section per part of `render`.
- `kit.ts`: reusable constructions (comparisons, integer one-hots, gathers, prefix sums, first set bit, the shared spring matrix) and measurement helpers.
- `gallery-app.ts`: the source table, event latches, next-source write-back, DOM projection and side effects. The demo and the tests share it.
- `reference.ts` and `fake-dom.ts`: the original index.ts executed natively, with only its types erased and its data import replaced by a parameter. It runs against a fake browser that records DOM writes, `scrollTo` calls, URL changes and selections.
- `differential.ts`: runs one interaction trace through both and compares every frame. It also counts how often index.ts's own decisions changed, so the check counts can be read as coverage.
- `edge-probe.ts`: tries pointers right next to box edges, where index.ts's float64 edges and the circuit's FP32 edges differ.
- `captions-reference.ts`, `prepare-captions.ts`, `caption-breakpoints.json`, `port-layout.ts.txt`, `port-prompt-layout.ts.txt`: the caption variant, which follows vibescript's photo-gallery port (vibescript commit f37a575).
- `photo-data.ts`: a byte-for-byte copy of the fixture's data (same git blob hash), so the demo can import it. A test checks it against `data.ts.txt`.

`numeric-ui-core.ts` is unchanged.

## What was built

| Part of `render` | index.ts lines | Circuit construction |
| --- | --- | --- |
| Column count and box width | 83-91 | Six integer ramps `[windowSizeX - 24 >= 244k]`, for k = 2..7, give an exact one-hot of the column count. The box width is one of seven constant reciprocals, read through that one-hot with a gather. |
| Row heights and row tops, which depend on the column count | 293-312 | One specialization per column count: a max tree per row (at most 7 photos), and one `roundAffine` fold per row top, which is a one-layer prefix sum. Each photo reads its row's values through a gather over the column one-hot, so the seven variants cost no masked products. |
| 2D destinations and hover | 326-347 | Affine per photo. Hover is a containment test per photo on the new targets. Grid boxes don't overlap, so these bits are already at most one-hot. The magnet offset is one ReGLU gated by the hover bit. |
| Clicks and keys | 216-228, 269-289 | A click tests containment against each photo's previous destination (the rectangles index.ts presented last frame), then a first-set-bit tournament picks among the 221 bits. Arrow keys, Escape, and the strip's left and right click regions are integer arithmetic on the focused index. |
| 1D strip | 358-386 | One prefix sum of unfocused widths, plus two gathers at the focus. Photos before the focus sit at `152 - (prefix[focus] - prefix[i])` and photos after it at `windowSizeX - 100 + prefix[i] - prefix[focus + 1]`. The focus one-hot comes from integer ramps on the new focused index. |
| Scroll back to a photo after closing the strip | 317-324 | The photo's row top through a gather over the old focus and the column one-hot, then two comparisons and one gated difference. |
| Scroll anchor | 348-357 | The anchor's destination through a gather. The search loop, for the first box whose bottom is more than 20% of the window below the scroll position, becomes a count of predicate bits over the first photo of each row. This works because those bottoms increase with the row, so the predicate flips only once. |
| Springs | 172-194, 399-407 | index.ts steps each spring `floor(elapsed / 4)` times, with no cap. The circuit splits elapsed time into three base-16 digits of the step count (45 threshold bits, so 0..4,095 steps or 16.4 seconds). It looks up each digit's matrix power from a constant table, multiplies the three into one shared 2x2 matrix, and applies that matrix to all 1,326 springs. Settling uses index.ts's rule, `|x| < 0.01 and |v| < 0.01`. Reduced motion zeroes the shared matrix. |
| Occlusion | 410-419 | Four comparisons per photo on the new positions, combined in one saturating ReLU. |
| Prompt selection | 277-283 | One bit, click AND the target is a caption. JS reads that output and makes the DOM Range. |
| Captions (variant) | vibescript `layout.ts`, `prompt-layout.ts` | pretext tabulates each prompt's two-line and three-line breakpoints once. A grid box's height is `sizeX / ar + 34 + 18 [inner width < twoLines]`. The port's `get1DItemSize` loop is a fixed point between prompt height and image width. It settles on 3 lines if the 3-line image still needs 3 lines, else on 2 lines if the 2-line image needs 2, else on 1, so it unrolls into two comparisons per scale. |

Constructions that apply beyond this app:

- A comparison `[a >= b]` is `boolean(1 - relu(1 - 2 relu(2^40 d + 0.5)))` on a preserved difference `d = roundAffine([[a, 1], [b, -1]])`. Strict `>` drops the 0.5. Several conditions combine in one saturating ReLU, e.g. a containment test is 4 differences, 4 ReLUs, 1 ReLU and a boolean. The result is exact for any finite difference that is either zero or at least 2^-41 in magnitude. There's no upper limit, because the saturation computes `1 - 2 × score` and never `score - 1`, so the `clamp01` hazard above 2^23 doesn't apply. `kit.test.ts` checks this on 2,000 random FP32 pairs of equal, adjacent and far-apart values with magnitudes from 2^-25 up to 2^26, skipping differences inside the 2^-41 band, and on four hand-picked pairs with magnitudes up to 1e25. Exact here means exact on the FP32 inputs. When the inputs are positions that drifted from index.ts's float64 positions, the decision follows the drifted value (see "Which decisions are exact").
- The one-hot of an integer index uses shared ramps `relu(index - k + 1)`, i.e. `count - 2` ReLUs for `count` positions. The compiler lowers gathers over such a one-hot to indexed reads: the default circuit has 457 of them, and their products store no weights.
- Each spring commits its displacement from last frame's destination, plus that destination, rather than index.ts's absolute position. The reason is explained under "What got awkward".

## Measured results

### Size

| Configuration | Live operations | Layers | Stored weights | ReGLU | Boolean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default: first-set-bit click tournament, one-layer prefix sums | 48,411 | 61 | 174,708 | 28,474 | 883 |
| Click selection by prefix count, `relu(hit_i - Σ earlier hits)` | 48,129 | 41 | 197,951 | 28,254 | 883 |
| Click selection by the library's `emitFirstActive` | 48,914 | 80 | 174,961 | 28,474 | 883 |
| Brent-Kung prefix sums | 49,837 | 61 | 116,442 | 28,474 | 883 |
| Brent-Kung prefix sums and click selection by prefix count | 49,555 | 49 | 139,685 | 28,254 | 883 |
| Spring products written with offsets (see "Bugs the differential tests found") | 43,111 | 61 | 164,104 | 23,170 | 883 |
| Captions from the vibescript port | 53,960 | 61 | 186,827 | 32,185 | 883 |
| IndirectOS (window manager with Photos), for scale | 5,253 | 192 | 11,598 | | |

The source table has 4,004 cells: 26 inputs and committed values, plus 18 per photo (displacement, velocity and destination for 6 springs). Building the circuit takes about 100ms.

### By feature, default configuration

| Feature | Live operations | Stored weights | Layers occupied |
| --- | ---: | ---: | --- |
| Springs | 31,191 | 63,824 | 1-58 |
| Destinations, strip hover, magnet | 4,202 | 21,188 | 20-43 |
| Focus from keys and clicks | 2,751 | 6,246 | 1-39 |
| 2D targets and hover | 2,652 | 4,862 | 8-19 |
| Occlusion | 2,210 | 4,199 | 52-61 |
| 2D rows for 7 column counts | 1,836 | 41,527 | 1-13 |
| Scroll adjustment and anchor | 1,808 | 3,708 | 1-58 |
| 1D strip | 967 | 27,384 | 1-39 |
| Focus one-hot | 439 | 878 | 36-37 |
| Column count, 2D sizes, pointer, outputs | 355 | 892 | 1-40 |

Springs are 64% of live operations. The depth is one long chain: pointer, click tournament, new focus, strip gathers, destinations and magnet (layer 43), anchor and scroll adjustment, springs (58), occlusion (61).

### Against the trace compiler's slices of the same file

| Slice | Trace compiler: operations / layers / weights | Here: live operations / layers / weights |
| --- | --- | --- |
| Column count and box width | 524 / 91 / 700 | 30 / 6 / 54 |
| 2D grid layout for 1..7 columns: each photo's x, y, width, height, scale and fxFactor destinations, plus the total height | 24,894 / 600 / 38,810 | 2,833 / 15 / 43,037 with one-layer prefix sums; 3,868 / 24 / 8,299 with Brent-Kung |
| 1D strip, with the focused index as an input: each photo's x, y, width, height, scale and fxFactor destinations, plus its x velocity after the edge rubber band | 21,213 / 1,580 / 31,290 | 3,399 / 9 / 35,986 with one-layer prefix sums; 3,790 / 21 / 12,458 with Brent-Kung |
| Occlusion bits from positions | 25,416 / 32 / 34,477 | 2,210 / 4 / 4,199 |
| Spring stepping | 14 / 8 / 24 per step, rejected for its runtime step count | the shared step matrix is 242 / 16 / 553, computed once; 1,326 springs on top of it are 28,090 / 24 / 54,910 |

The 2D and 1D rows compile the same outputs on both sides (the trace compiler's are listed in `lab/trace-compiler/real-slice.ts`). One small difference remains: the trace compiler's 1D slice takes the rubber band velocity as an input, while the slice here decodes it from the key bits. The trace compiler's 2D slice leaves out hover, the scroll adjustment and the anchor search; the circuit here has them in other sections. Most of the difference comes from the trace compiler lowering every comparison to a 25-layer sign cascade and every accumulation to a sequential chain.

### Differential checks against index.ts

Both sides run the same trace. Every frame, decisions are compared exactly: whether index.ts would request another frame, the URL focus, whether `scrollTo` and `pushState` were called, prompt selection, the cursor, body overflow, the anchor index, index.ts's animation step count (recovered from `animatedUntilTime` when it keeps animating), and every photo's visibility. For visible photos it also compares z-index, prompt overflow, prompt height, line clamp, image display, the filter kind, and the full resolution image source. Continuous values are compared as errors: spring positions and velocities, destinations, scroll position, placeholder height, and the numbers inside every style string. Random traces mix mouse moves aimed at boxes; clicks on boxes, prompts, background, and the strip's left and right regions; arrow keys and Escape; resizes (30% at column boundaries); scrolls; URL changes; and short episodes of reduced motion.

| Run | Size | Decision checks | Mismatches | Largest continuous errors |
| --- | --- | ---: | ---: | --- |
| Every integer width 320..3840 at height 900: column count and 2D destinations | 3,521 widths | 3,521 | 0 | destinations 0.18px, at 98,197px |
| 6 random traces, 600 frames each, dyadic frame durations, free-running | 3,600 frames, 2,192 in the strip, 3,428 animating; 1,814 moves, 434 clicks, 348 keys, 88 resizes, 86 scrolls, 26 URL changes | 957,258 | 0 | destination x 0.28px, y 0.13px, scroll 0.05px, style transforms 0.06px, sizes 0.0004px |
| 6 more random traces with the same seeds and viewports, microsecond timestamps with jitter, free-running. The durations draw from the same random stream as the events, so the events differ from the row above. | 3,600 frames, 2,338 in the strip, 3,435 animating; 1,798 moves, 406 clicks, 361 keys, 84 resizes, 75 scrolls, 44 URL changes | 939,289 | 0 | destination x 0.30px, style transforms 0.11px |
| The dyadic traces again, with the original's state copied into the circuit before every frame | 3,600 frames, same events as the dyadic row | 957,258 | 1, from the harness (below) | style transforms 0.08px |
| Scripted trace: hover, open, arrows, resize while open, click the right region, hover the left region, Escape, scroll, resize, click a prompt, open from the URL, ArrowRight at the last photo, Escape, open and close from the URL | 420 frames | 126,182 | 0 | style transforms 0.007px |
| Pointers right next to box edges, at 6 viewports and scroll positions (table below) | 308 hover points, 172 click trials | 480 | 10, all between index.ts's edge and the circuit's edge | edges 0.18px |
| Caption variant against vibescript's `layout.ts`, grid at every width 320..2000 | 1,681 layouts, 371,501 boxes | line counts | 0 | positions 0.18px, sizes 0.00007px |
| Caption variant, strip at 400 random widths, heights, focus and scroll positions | 88,400 boxes | line counts | 0 | positions 0.31px |
| Caption breakpoint table against pretext's line walker | 2,120,937 widths at 0.25px steps, plus 44,200 random widths | line counts | 0 | line count never rose as width grew |

The raw check counts overstate what the traces tested. Of the 957,258 checks in the dyadic run, 795,600 (83%) are one visibility bit per photo per frame, most of them for photos far offscreen. Five of the seven checks per visible photo (z-index, prompt overflow, prompt height, line clamp, image display) are strings derived from the same focused bit. This table shows how often index.ts's own value of each decision changed, which says more about coverage:

| Decision | Dyadic traces | Microsecond timestamp traces | Scripted trace |
| --- | ---: | ---: | ---: |
| Visibility flips | 5,865 | 5,775 | 176 |
| Animation step count changes | 2,628 | 2,478 | 105 |
| Cursor changes | 1,077 | 1,113 | 9 |
| URL focus changes | 643 | 637 | 11 |
| Clicks that opened the strip from the grid | 103 | 106 | 1 |
| Anchor changes | 160 | 158 | 3 |
| Frames with a `scrollTo` call | 136 | 135 | 2 |
| Settle and start transitions of "still animating" | 94 | 99 | 0 |
| Frames with a prompt selection | 20 | 15 | 1 |

The continuous errors come from large coordinates. Strip and row positions are differences of prefix sums that passed 170,000px in these traces, where FP32 values are 1/128 to 1/64px apart. Onscreen style transforms differ by up to about 0.11px.

The column count is exact at every width, including 512, 756, 1000, 1244, 1488 and 1732, where the trace compiler's FP32 reciprocal picks one column too few.

The one mismatch in the copied-state run is an artifact of copying. One frame closes the strip and runs no animation steps, and the next frame reopens it from the URL. Copying pairs the original's float64 displacement with the circuit's own FP32 destination, which is 0.036px higher at 69,232px. So in the circuit only, reopening looks like a 0.036px displacement. The reopening frame runs 4 animation steps on both sides, which don't settle that displacement, so the circuit animates one frame longer. Free-running, the circuit's own destinations cancel exactly, and seed 5001 has no mismatch.

### Which decisions are exact

The kit's comparisons are exact on their FP32 inputs, so a decision is exact for every input when its inputs match index.ts exactly:

- the column count, for integer window widths;
- keys and the focus arithmetic on them, the one-hots and gathers over integer indices, and prompt selection;
- the strip's left and right click and hover regions, which compare the pointer with constants and the window width, for pointers FP32 represents exactly, e.g. quarter pixels;
- the animation step count, for frame durations FP32 represents exactly, e.g. the dyadic durations above. With microsecond timestamps the step counts matched in all 3,435 checks, but a leftover time within about 1e-6ms of a multiple of 4ms could round to a different step count.

Other decisions compare positions that drift from index.ts's float64 positions: 2D hover and click, the anchor search, the scroll back to a photo after closing the strip, occlusion, and settle timing. These decisions can differ when an input lands inside the drift, which reaches about 0.3px far down the page or along the strip, and about 0.00001px at the top of the page. Decisions that follow from them inherit that, e.g. the URL focus, body overflow and the cursor after a click in the grid. Random pointers almost never land in such a thin band, which is why the random traces didn't find it.

`edge-probe.ts` looks for it directly. It tries quarter-pixel pointers around every onscreen box edge, compares the cursor after a move and the URL focus after a click, and sorts mismatches by whether the pointer lies between index.ts's version of the edge and the circuit's version. For example, at 500x900 scrolled to the bottom, photo 220's top edge is at 98,197.6066px in index.ts and 98,197.7891px in the circuit, so a click at clientY 349.75 opens photo 220 in index.ts and does nothing in the circuit.

| Viewport and scroll position | Largest edge drift | Pointers tried | Pointers between the two edges | Hover mismatches | Click trials | Click mismatches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500x900, bottom (scrollY 97,848) | 0.18px | 24 | 3 | 3 | 24 | 3 |
| 390x844, bottom (scrollY 77,969) | 0.10px | 23 | 2 | 2 | 23 | 2 |
| 320x700, 97% down (scrollY 63,465) | 0.0096px | 24 | 0 | 0 | 24 | 0 |
| 760x900, bottom (scrollY 20,273) | 0.0075px | 99 | 0 | 0 | 40 | 0 |
| 1440x900, bottom (scrollY 14,085) | 0.0048px | 117 | 0 | 0 | 40 | 0 |
| 500x900, top | 0.00001px | 21 | 0 | 0 | 21 | 0 |

Every mismatch is at a pointer between the two versions of an edge, and every such pointer flips both hover and click. A test in `differential.test.ts` checks this for the first row, with all 24 hover points and 8 click trials (the 3 between the edges and 5 others).

### Bugs the differential tests found

Each of these passed the smaller tests first, so they're worth keeping in mind for other circuits:

1. Absolute spring positions. FP32 positions near 100,000px are 1/64px apart, so a spring there can never come within 0.01px of its destination. It keeps moving between neighboring values, and the page never stops animating. The fix commits each spring's displacement from last frame's destination, plus that destination.
2. Spring products with offsets. Writing `x × m` as `x × (m - c) + c × x`, where `c` is a negative power of two below every entry of `m`, makes each product one ReGLU instead of two. After a long stall `m` has decayed to about 1e-6. If a 50,000px jump happens in the same frame, the two terms nearly cancel and leave 0.01-0.05px/s of rounding noise in the velocity, so springs settle frames late. Signed products, `x relu(m) - x relu(-m)`, cost 5,300 more operations and fix it. With offset products, three 300-frame random traces (seeds 101-103) still show 50, 130 and 87 decision mismatches; with signed products they show none. Of those mismatches, 23, 71 and 26 come from the animation step count check: after a spring settles late, the next frame starts from a different committed time, so its step count differs too.
3. Table lookups over threshold bits. Selecting a matrix power `M^(16k)` as `T[0] + Σ bit_j (T[j] - T[j-1])` passes through partial sums of order 1. So an entry near 1e-6 carried 10% error after a 912ms stall, and six springs settled one frame early. Materializing the one-hot members of each digit first costs 48 operations, and each entry's fold then adds the selected table value once.
4. The edge rubber band. index.ts adds this velocity only inside its strip branch. When ArrowLeft on the first photo and a click that closes the strip land in the same frame, the circuit kicked every photo's velocity by 500px/s. The fix requires a new focus.

### CPU timings

These are rough, because about a dozen other agents shared the machine. The two runs are the same report script at different times.

| Program | µs per evaluation, first run | µs per evaluation, second run |
| --- | ---: | ---: |
| Gallery circuit, executor | 375 | 508 |
| Gallery circuit, generated plain JS, at most 150 statements per function (2,242 functions), after 6,000 warm runs | 428 | 566 |
| IndirectOS, executor | 37 | 41 |
| IndirectOS, generated plain JS, after 6,000 warm runs | 3.1 | 2.8 |
| index.ts `render` natively, including fake DOM writes, while animating | 13 | 14 |

`report-output.json` holds the second run.

## What this shows about how far the approach goes

### What fit well

- The whole render path fits in one circuit, and the loops that made the trace compiler deep became shallow. With the same outputs, the 1D strip is 9 layers instead of 1,580, the 2D grid 15 instead of 600, and occlusion 4 instead of 32.
- Decisions matched index.ts in every sampled trace: 0 mismatches in about 2 million free-running decision checks over 7,620 frames. In the dyadic traces alone, that includes 160 anchor changes, 94 settle and start transitions, 103 clicks that opened the strip, 2,628 step count changes and 5,865 visibility flips. The column count is right at every width. Decisions that only depend on integers and bits, like the column count, keys and the focus arithmetic, are exact for every input. Decisions that compare positions, like 2D hover and click, follow the circuit's FP32 positions, so they can differ from index.ts for inputs inside the drift (see "What got awkward").
- Every loop in the render path turned out to be one of a few shapes, each with a construction:
  - maps over photos;
  - reductions, e.g. the row maximum or "any spring still animating";
  - prefix sums, e.g. row tops and strip lefts;
  - first-match searches: the click hit test as a tournament, and the anchor search as a count because its predicate flips once;
  - a runtime iteration count, for springs, as a product of table powers.

  Reading at a runtime index, e.g. `rowsTop[Math.floor(focused / cols)]` or `data[anchor].y.dest`, is always a gather over a one-hot built from integer ramps.
- index.ts's own animation timing is cheaper as a circuit than IndirectOS's four substeps: fixed 4ms steps that catch up after a stall. One 242-operation step matrix serves all 1,326 springs, and trajectories don't depend on frame rate. The spiral-of-death cap that index.ts lacks becomes the number of digits.
- The structural choice between 1..7 columns costs little, because the variants differ only in wiring, and positions read them through lowered gathers.
- Captions from the vibescript port fit as comparisons: one per photo in the grid, two per scale for the strip's fixed-point loop.
- Authoring by hand stayed readable. `gallery-circuit.ts` is about 680 lines, next to index.ts's 475, and most sections map to a block of index.ts lines. The constructions live in a 560-line kit.

### What got awkward

- Everything per photo is written out 221 times. That's 48,000 live operations, about 9 times IndirectOS, and springs are 64% of them. A settled gallery still evaluates every spring.
- Depth is 61 layers, set by a long chain of dependencies:
  1. a click decides the focus;
  2. the focus decides strip positions;
  3. destinations decide the anchor;
  4. the anchor decides the scroll adjustment;
  5. the scroll adjustment shifts springs;
  6. springs decide occlusion.

  The click tournament accounts for about 20 of the 61 layers. Selecting the click by prefix count brings the total to 41 layers, at 23,000 more stored weights.
- One-layer prefix sums store n^2/2 weights: 41,000 for the seven row layouts and 24,000 for the strip. Brent-Kung trades those weights back for depth.
- FP32 at large coordinates. The strip passed 170,000px in these traces and would reach about 260,000px on a 4K display. Positions there are 1/64px apart, prefix-sum differences carry 0.3px of absolute error, and springs that store absolute positions never settle. The drift also reaches decisions that compare positions: at 500x900 scrolled to the bottom, 3 of 24 pointers tried around box edges get a different hover and click result than in index.ts. index.ts, in float64, has none of these problems.
- Exactness had to be designed in and measured. Two constructions that looked cheaper, offset products and telescoped table lookups, produced wrong settle timing, and only long free-running traces exposed them. The tests that caught them had to use relative errors, and both fixes cost operations. Random traces also turned out to be a weak probe for thin bands: they passed millions of checks, while a targeted probe of box edges found flips right away.
- On the CPU, the executor takes about 375-510µs per frame, while index.ts natively takes 13-14µs, DOM writes included. Generating plain JS from the compiled program didn't help at this size. IndirectOS drops from about 40µs to 3µs that way, but the gallery's 48,000 operations become thousands of generated functions that each have to warm up. With at most 150 statements per function, the first 1,000 runs take about 15 seconds, and after 6,000 runs it still takes about 430-570µs, slower than the executor. With 600 statements per function, a separate run took about 125 seconds of warmup to reach 1,050µs.
- The source table changed shape: spring displacements and destinations instead of positions, 4,004 cells. Declared source ranges are hard contracts, e.g. pointer coordinates within ±65,536px. My first trace generator broke that contract by aiming the pointer at boxes far offscreen.

### What stayed outside the circuit

- The id scan of the URL hash (JS writes the focused index and a present bit), `pushState`, and reading the focus back from the URL.
- `scrollTo`, reading scroll positions, and the browser's scroll clamping.
- Prompt selection with a DOM Range, and knowing that the click target is a caption. The circuit gets that as one bit, and JS selects the caption when the circuit's selection output is 1.
- DOM nodes, attaching and detaching them from visibility bits, and formatting CSS strings.
- Loading the full resolution image. The circuit outputs the focused bit and the still-animating bit.
- The frame duration: JS subtracts the previous rAF timestamp, and the circuit keeps the leftover milliseconds.
- The initial spring state at load, which index.ts also computes in JS before its first render.
- pretext's prepare step, which produces the caption breakpoint table.
- Safari's choice of scroll element. The demo only handles the window.

## Open questions and next steps

- An instance axis. All 221 photos run the same per-photo program with different constants. An executor that applies one per-photo program to a batch would remove the duplication. The shared spring matrix already works that way.
- Settling once per photo instead of once per spring would save about 9 operations per spring, but it changes when a photo stops moving.
- Smaller drift where decisions depend on positions. Far down the page, hover and click can flip within about 0.18px of a box edge. E.g. row tops could be summed in two parts, whole pixels and the fraction, so the fraction keeps its precision at 100,000px. I haven't tried it, and FP32 still can't represent index.ts's float64 edges exactly.
- Real fonts. The breakpoint table uses fake per-character widths. A browser page would tabulate at load with canvas measurements. The demo still clamps captions with CSS, like index.ts.
- Depth could drop by computing hover, the anchor and occlusion from last frame's values, the way index.ts already hit-tests clicks against last frame's destinations. That would change behavior by one frame.
- Several events of one kind in one frame. Latches keep only the latest, like index.ts, and a trace with two moves in one frame would lose the first.
- Code generation that scales: e.g. one function per repeated per-photo block with the photo's constants passed in, or a typed-array loop per layer shape, instead of thousands of distinct generated functions.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/gallery/demo.html`, with colored rectangles rather than `?photos=cdn`.

- The page loads with no console errors. The HUD shows 48,411 live operations, 61 layers and 174,708 stored weights.
- On load, every box starts off-screen and springs in, as index.ts does, so the first frame draws no boxes.
- Hovering a box sets the zoom-in cursor. Clicking a box opens the 1D strip with that photo centered, sets the URL hash, sets the zoom-out cursor, and hides the body's vertical overflow. ArrowRight twice moves the focus and updates the hash. Escape goes back to the grid, clears the hash, and restores scrolling. After scrolling the grid down 1,000 px, 29 boxes were attached, none of them far outside the viewport.
- The HUD's render time with DOM writes was 22 to 24 ms on the first frames, about 7 ms while the grid animated in, and then 0.7 to 1.2 ms.
- Not checked: `?photos=cdn`, window resizing, and clicking a caption to select its prompt.
- No fixes were needed.
