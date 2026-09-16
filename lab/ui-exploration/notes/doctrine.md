# Cheng's UI doctrine and personal sites, read against the circuit approach

Status, September 15, 2026: written in phase 1, before the round 2 prototypes. Later measurements are in the [exploration README's capability map](../README.md#capability-map), and the current runtime's contracts and costs in the repo root's [execution-model.md](../../../execution-model.md). What this note says about IndirectOS describes window-manager.ts before September 15, 2026, when its springs, hit tests, Photos clicks and window content sizes changed ([lab/status.md](../../status.md#runtime-additions-since-september-14-2026)).

These are phase 1 notes for the question "how far does the IndirectOS matmul approach take us for writing UI?" This area covers Cheng's written doctrine and Cheng's two personal sites:

- Doctrine, read fully, from vibescript's `docs/` folder: `ui.md`, `Animation.md`, `Input.md`, `Scrolling.md`, `FrameScheduling.md`, `engineering.md`, `router.md`, `z-index-depth-management.md`. Skimmed: `media.md`, `drafts/layout-geometry.md`, `drafts/verification.md`, `drafts/automating-browsers.md`.
- Sites: chenglou.github.io's `index.ts` (the Midjourney gallery, 222 photos in `data.ts`) and nicer-hacker-news's `hn.js` (with `hn.html` and `data.js`: 32 threads, which are copies of two distinct threads, one with 30 comments nested up to indent 7 and one with 4 comments).
- For comparison, from the indirect repo: `README.md`, `execution-model.md`, `tricks.md` (now `expressions.md`), `parallel-winner.md` (now part of `patterns.md`), `macro-ranges.md` (now part of `execution-model.md`), `lab/status.md`, the macros in `numeric-ui-core.ts` (lines 1129-1405), the IndirectOS machine and render loop in `window-manager.ts` (lines 1190-1520), the Photos circuit and renderer in `photo-gallery.ts`, and the READMEs of `lab/trace-compiler` and `lab/event-window`, skipping their training parts. I also ran `bun lab/runtime-cost/report.ts`.

Line numbers in `numeric-ui-core.ts` refer to commit c3d8e54 (September 5, 2026); on September 14, 2026 the file grew from 1,653 to 3,158 lines.

Measurement scripts are session scratch files (scratch folder `phase1/doctrine/`, not in the repo):

- `measure.ts`: accumulating row positions with five constructions, and a spring with the doctrine's fixed 4ms steps built from matrix powers.
- `hn-hit.ts`: hn.js hit testing (row under the pointer, gutter or comment, ancestor search, shrink bits) as a circuit, checked against the hn.js logic.
- `staircase.ts`: whether pretext's line count only goes down as width grows, over the HN paragraphs and gallery prompts, using a copy of pretext's `src/` and a fake canvas.
- `gallery-springs.ts`: all 1,332 springs of the gallery sharing one runtime step matrix, and occlusion bits for 222 boxes.

## Main findings

1. Cheng's render loop (ui.md:5-24) already has the shape of a circuit's frame. DOM reads become source cells, "handle inputs, layout, animation tick" is the circuit, "commit state" is the next-source outputs, DOM writes and side effects are JS projections of outputs, and "schedule next render" is one output bit. IndirectOS's `machine.step` plus `renderWindowManager` (window-manager.ts:1279-1295, 1418-1477) is that loop. The doctrine's rules about the DOM (set the full attribute set every frame, one owner per dynamic attribute, reset event fields at the end of the frame, no logic in event callbacks) are what a fixed output layout enforces anyway.
2. The doctrine's performance ethos already accepts what a circuit does: "We prefer making systems with even latency and throughput, like shaders or real-time systems: branchless, predictable, uniform-cost ... try to first and only cater to worst-case frame latency" (engineering.md:78). ui.md:299 says to borrow "shader/pytorch/vector primitives". A circuit that computes every item every frame, with no early exit, is the extreme version of that preference.
3. Almost every loop in both sites is one of four shapes: a per-item map, a reduction (max, sum, or), a prefix sum (accumulating y positions), or a first-match search with early exit (hit testing, anchor search, ancestor search). Maps and reductions compile directly. Prefix sums and first-match searches each have cheap known rewrites, measured below. The two sites contain no sort.
4. Accumulating positions doesn't need one layer per row. For 221 rows, a sequential chain costs 221 layers, a Brent-Kung scan 14 layers and 1,074 weights, a Kogge-Stone scan 9 layers and 3,230 weights, and one triangular affine layer 1 layer and 24,310 weights. The trace compiler worried that parallel prefix sums change FP32 rounding order. Measured, balanced sums drift less than the sequential chain: 0.006px against 0.015px at 221 rows, and 0.08px against 0.74px at 4,000 rows (about 930,000px of content).
5. Springs with the doctrine's timing (fixed 4ms steps, a variable number of steps per frame, a cap) are cheap as matrix powers. One step of the semi-implicit Euler spring is a fixed 2x2 linear map, so N steps is that matrix to the power N, and the bits of N select precomputed powers. All springs with the same stiffness and damping share one runtime 2x2 matrix per frame, so a bank of springs is literally one sparse matmul. For all 1,332 gallery springs, including per-spring settle snapping, that's 40,243 live ops, 36 layers, and about 219µs per frame on the CPU evaluator. The drift from float64 iteration was at most 0.00028px. IndirectOS currently runs 4 substeps of `min(frame duration, 32ms) / 4`, which ties the trajectory to frame rate and slows motion down after a stall instead of catching up.
6. Hit testing doesn't always need a tournament. Overlapping boxes with a priority need `emitFirstActive` or a rank chain. Non-overlapping boxes need nothing, because their containment bits are already at most one-hot. Sorted rows get their one-hot from the difference of adjacent step bits. The HN hit test for 30 rows (row, gutter, ancestor, 30 shrink bits) is 511 live ops and 13 layers, and matched hn.js in 20,000 random trials.
7. Tree walks over static structure turn into constant tables. HN's ancestor search (a `while` loop over indents) and gutter extents (a loop over each subtree) depend only on indents, which never change at runtime. A prepare step computes the tables, and the runtime part is a gather of 8 products or plain wiring.
8. For text, heights can enter the circuit as comparisons only. Over 81 HN paragraphs and 222 gallery prompts, pretext's line count never went up as width grew (0.25px sweeps with fake glyph widths). A paragraph's height at any width is therefore a count of precomputed width thresholds above that width. There were 1,605 thresholds in total, at most 22 per paragraph, and the rebuilt line counts matched `measureLineStats` at all 60,600 random widths tried. This moves line breaking entirely into pretext's prepare step. Painting line fragments is a much bigger table, one staircase per line.
9. What stays outside is small and well defined: strings (URL parsing, key codes, regex search, `innerHTML`), DOM identity (`e.target`, `elementFromPoint`), native text queries (`caretRangeFromPoint`, `Range.getClientRects`), DOM node lifetimes (domCache), canvas drawing, and platform side effects (`scrollTo`, `pushState`, selection, `img.src`). Each of these exchanges only numbers with the circuit: an index, a bit, a rectangle, a timestamp.
10. Divergences noticed while reading, reported without judgment: index.ts runs the spring loop without the 300-step cap the doctrine recommends (index.ts:513). index.ts hit-tests clicks against the rectangles presented in the previous state, while hover uses the new targets (index.ts:273, 446). hn.js measures comment heights through the DOM once at load, with `window.innerWidth`, and never again on resize (hn.js:180, 213). The vibescript port of HN fixes that with pretext (`demos/nicer-hacker-news/index.ts:316-323`).

## How to read the status column

- "Maps directly": the technique compiles with the existing atoms and macros (affine, reglu, boolean, multiply, select, min, max, clamp, `emitSpring`, `emitArgmax`, `emitFirstActive`), and often IndirectOS already does it.
- "Needs reformulation": the JS form (an early exit, a loop with a runtime count, division by a runtime value, a tree walk) doesn't compile as written, but a known rewrite exists. The table names the rewrite and its cost.
- "Outside": strings, DOM identity, platform side effects, native browser features. The table names what crosses the boundary as numbers.

## 1. The render loop is already the circuit's frame

| Doctrine phase (ui.md:7-24) | index.ts | hn.js | Circuit counterpart |
| --- | --- | --- | --- |
| Initialization: state declaration, initial derived state, static DOM, event registration | 126-267 | 168-224 | Initial source table; static DOM creation stays in JS. IndirectOS fills constants and initial geometry in `createWindowManagerMachine` (window-manager.ts:1190-1240). |
| DOM reads, batched | 339-346 | 238-240, 247 | JS writes viewport size, scroll position, media query bits, and frame time into source cells (window-manager.ts:1285-1287). |
| Handle inputs | 348-392 | 311-355 | Circuit, reading latch cells. |
| New layout and cursor | 394-509 | 266-309, 377-394 | Circuit. The cursor is a small integer code or a one-hot over cursor kinds. |
| Animation tick | 511-523 | 357-392 | Circuit (springs, easing). |
| Commit state | 525-539 | scattered mutations | Next-source outputs, copied back into the source table (window-manager.ts:1290-1292). |
| Occlusion and DOM writes, batched | 541-587 | 396-508, 642-649 | JS formats circuit outputs into styles, and creates or removes nodes from visibility outputs (photo-gallery.ts:727-771). |
| Side effects: `scrollTo`, `pushState`, selection | 589-605 | 510-560, 590-640 | JS, driven by output numbers and bits. |
| Schedule next render if animating | 607 | 659 | One output bit (`animationActive`, read at window-manager.ts:1472). |

Two more doctrine rules map one to one:

- "Only events and render's final step can schedule a next render" (ui.md:85). IndirectOS's event listeners only write latch cells and call `scheduleRender` (window-manager.ts:1479-1516).
- "Don't forget to reset ephemeral events" (ui.md:117). IndirectOS writes zero to every event active cell in the next source (window-manager.ts:1020).
- "First paint uses the same data flow" (ui.md:87-93). IndirectOS runs one render synchronously at the end of `mountWindowManager`. A `timeInitialized` source cell makes the first frame's duration zero (window-manager.ts:402-416).

## 2. Catalogue

Each row lists the technique, where it appears, its computational shape, its status, and what crosses the boundary or what the reformulation costs.

### 2.1 Frame scheduling and time

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| One `render(now)` with fixed phases | ui.md:5-83, index.ts:334-608, hn.js:233-660 | Whole-frame pure function between reads and writes | Maps directly | IndirectOS `machine.step` |
| `scheduleRender` deduplicates `requestAnimationFrame` | ui.md:34-41, index.ts:3-12 | Platform side effect | Outside | One output bit |
| First paint uses the same derivation as later frames | ui.md:87-93, index.ts:184-217 | Same function at startup | Maps directly | Initial source table plus one synchronous step |
| Fixed 4ms simulation steps: `steps = floor((now - animatedUntilTime) / 4)`, then `animatedUntilTime += steps * 4` | ui.md:62-65, Animation.md:40-42, index.ts:512-514 | Integer division, then a loop with a runtime count | Needs reformulation | JS (or the circuit, with threshold bits) computes the integer step count. The loop becomes selected matrix powers (section 3.2). |
| Spiral of death cap `min(300, steps)` | ui.md:64, Animation.md:72-74 | Clamp | Maps directly | In the matrix-power form, the cap is the number of step bits, e.g. 9 bits allow 0..511 steps |
| Three clocks: rAF `now`, `document.timeline.currentTime` inside handlers, `event.timeStamp` for input timing | FrameScheduling.md:21-37 | Platform reads | Outside | Frame time, previous frame time, and per-event timestamps as cells |
| Debug stepping: key A advances a fake timestamp by 1/60s | index.ts:127, 351-356 | State plus key bit | Maps directly | Timestamp cell |

### 2.2 Input

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Event callbacks only store raw input and schedule a render | ui.md:95-121 | Platform side effect writing cells | Outside by design | IndirectOS `receivePointer` writes an active bit and coordinates (window-manager.ts:1256-1261) |
| Reset event fields at the end of the frame | ui.md:117 | Next-state assignment | Maps directly | Zero in next source |
| Latest event of a kind wins, e.g. `st.events.click = e` | ui.md:119, index.ts:228-242 | Overwrite | Maps directly | One slot per kind. IndirectOS merges down, move, up in that fixed order with selects (window-manager.ts:684-697) |
| Accumulate every occurrence: sum wheel deltas, push keydowns onto an array | ui.md:119 | Sum; unbounded array | Sums map directly; arrays need reformulation | JS adds into one cell. Arrays become a fixed-capacity queue, or the circuit runs once per event (section 3.8) |
| Interpret all inputs together in render: a key press versus a concurrent click, a tap while another finger is held | ui.md:104-108, engineering.md:13 | Priority selection over input bits | Maps directly | Select chains or `emitFirstActive` |
| Pick the newest pointer event by `timeStamp` | Input.md:49-55 | Comparison and select | Maps directly | Timestamps as cells |
| Convert pointer coordinates to content space, e.g. `pointerYLocal = pointerY + scrollTop` | Input.md:29-47, ui.md:317 | Affine | Maps directly | |
| Key codes, `e.target.tagName === 'FIGCAPTION'`, "pressed and released on the same element" | index.ts:370-392, hn.js:546-548 | String comparison, DOM identity | Outside | Keys decode into bits in JS (IndirectOS `keydown` switch). DOM identity checks can become geometry hit tests once JS computes the layout, e.g. hit-test the prompt rectangle below the image |
| Three-state pointer ("up", "first down", "down"), advanced at the end of the frame | hn.js:110-117, 655-657 | Small state machine | Maps directly | Two bits |
| Pin springs during drag: `pos = dest = dragX` | Input.md:69-78 | Select | Maps directly | |
| Click versus drag slop, pointer ownership until release | lab/event-window | Latches written on event bits | Already expressed | 502 ops, depth 38 in the event-window circuit |
| Flick velocity from the last ~20 samples within ~100ms, divided by elapsed time | Input.md:80-97 | Ring buffer, backward first-match search, runtime division | Needs reformulation, or outside | Samples as a shift register (the event-window archive costs +36 ops per record). Samples are sorted by time, so "oldest within 100ms" is a count of bits. Division by elapsed time has no primitive. JS can compute the velocity at release and write one number |
| Z bands while dragging: dragged 300, last released 200, others `10 + orderedCardIds.indexOf(cardId)` | Input.md:99-117, z-index-depth-management.md:83-91 | Select chain; index lookup in an ordering | Maps directly | Ordering as a permutation matrix of bits, like IndirectOS's stack cells (window-manager.ts:89, 277) |
| Clear the last dragged item once it settles | Input.md:117 | Latch cleared by a settle bit | Maps directly | |
| Platform quirks: late or missing iOS pointer events, out-of-order timestamps, negative coordinates, 16px input font | Input.md:3-21 | Platform | Outside | Choosing which DOM events to listen to stays in JS |

### 2.3 State, randomness, routing

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Single global serializable state; keep the previous committed state for hit testing and debugging | ui.md:123-128, index.ts:154-157, 538-539 | Record | Maps directly | The source table is that serialization, and "previous state" is the table the circuit reads while computing the next one |
| `domCache` kept outside state, with a comment on each item's cache lifetime | ui.md:205-250 | Mutable references | Outside by definition | Visibility and "changed" bits decide create, attach, detach |
| Seeded pseudo-random `lowbias32` (`Math.imul`, xor, unsigned shifts), `hashFloat` over float64 words | ui.md:130-166; vibescript demos `spring-comparison/index.ts:26`, `predictive-keyframes/index.ts:5` | 32-bit integer bit mixing | Outside for runtime values | FP32 holds exact integers only up to 2^24 (expressions.md), so 32-bit mixing isn't arithmetic here. Hashes of static indices fold into constants at compile time. Hashes of values that change at event time, e.g. a new seed on click in spring-comparison, can run in JS at event time and write the result into a cell |
| Route as a tagged union, URL parsed once, `history.state` validated like stored data | router.md:7-50, 108-151 | String parsing | Outside | Route tag as a one-hot, payload as numbers or indices |
| Synchronous `sanitize` redirects: auth guards, owner validation | router.md:178-212 | Small finite function over tag bits and a user-present bit | Maps directly | |
| `encode(route)` and `pushState`; `readFocused` compares the URL hash with all 222 photo ids every frame | router.md:153-176, index.ts:176-180, 346, 603-605 | String building, string search, platform side effect | Outside | "Route changed" bit and focused index |
| "Parse and normalize early but don't interpret too early", interpret where all interacting data is visible | engineering.md:11-13 | | Supports the approach | The circuit is that place |

### 2.4 DOM projection and media

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Batch DOM reads before writes; helpers receive read values as arguments | ui.md:172-177 | Discipline | Maps directly | The source table enforces it |
| DOM as a pure projection: set the full attribute set every frame, one owner per dynamic attribute, no partial class toggling | ui.md:179-203 | Per-node map from state to properties | Maps directly | A fixed set of outputs per node. IndirectOS writes width, height, transform, opacity, z-index, `--focused`, `--maximized` for every window every frame (window-manager.ts:1425-1452) |
| Static properties at creation, dynamic properties every frame, never both | ui.md:252-255 | Split | Maps directly | Static in JS creation, dynamic from outputs |
| Cursor computed as a local value, written in the DOM write phase | ui.md:58-60, 177 | Enum | Maps directly | Integer code or one-hot; JS maps it to a string |
| domCache strategies: permanent nodes, wipe and recreate, create on first visibility and detach on occlusion, preserve stateful nodes, pools | ui.md:259-289 | Platform side effects | Outside | Driven by visibility outputs. The Photos renderer creates and removes nodes when `width > 0 && height > 0 && opacity > 0` (photo-gallery.ts:737-750) |
| Write only on change for stateful setters (`img.src`, `textContent`, `video.src`, appending a focused node) | ui.md:257, index.ts:572 | Compare with last written value | Outside | The circuit outputs the decision bit, e.g. "focused and not animating" |
| Format numbers into CSS strings: `translate3d`, `brightness(%)`, `linear-gradient(...)` masks | index.ts:554-560, hn.js:414-415, 465-466 | String formatting | Outside | Numbers per property |
| `decode()` before painting, poster below `<video>` until playback, release video resources when occluded | media.md:9-15, 32-38, 46 | Platform | Outside | Inputs: decoded bit, playing bit. Outputs: visible bit, "should be active" bit, e.g. from a count of visible videos |
| Canvas drawing of gutter lines, search dimming, highlight rectangles | hn.js:400-403, 472-495, 562-640 | Platform drawing | Outside | Line endpoints, rectangle numbers, emphasis bits |

### 2.5 Layout

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Absolute positioning computed in JS, minimal DOM nodes | ui.md:303-309 | Per-item map | Maps directly | |
| Viewport from `clientWidth`/`clientHeight` | ui.md:297 | Read | Outside | Two cells |
| Shader primitives: vec2/3/4, remap, clamp, fract, step, length | ui.md:299 | Affine, clamp, floor, sqrt | clamp, remap, step map directly; fract and length need reformulation | Bounded floor as a sum of threshold bits (trace compiler). sqrt as Newton steps from a lookup table seed |
| Column count `clamp(1, floor((w - 24) / 244), 7)` and column width `(w - 24 - cols * 24) / cols` | index.ts:105-113 | Bounded floor; division by a small runtime integer | Needs reformulation | Seven threshold bits give a one-hot over column counts; division becomes seven constant reciprocals selected by that one-hot. FP32 reciprocal rounding selects one fewer column at widths 512, 756, 1000, 1244, 1488, 1732 (lab/trace-compiler/README.md) |
| Row height = max over the items in the row; which items share a row depends on the runtime column count | index.ts:397-416 | Reduction per group; structure depends on a small choice | Needs reformulation | One specialization per column count, each a static max tree of width 7 or less, then a select (section 3.7) |
| Accumulating positions: `rowsTop.push(rowsTop.at(-1) + rowMaxSizeY + boxesGapY)`, HN `rowTop += row.height`, the 1D strip's `currentLeft` | index.ts:412, 469-497; hn.js:434-498 | Prefix sum | Needs reformulation | Parallel prefix scan (section 3.1). 221 rows: 14 layers, 1,074 weights with Brent-Kung |
| Centering `(container - containee) / 2` | index.ts:438-439 | Affine | Maps directly | |
| Unmeasured rows get a tight lower bound, never an estimate | ui.md:301 | Constants | Maps directly | |
| Don't let JS decide a size while CSS adds padding or margins that change the result | ui.md:305, drafts/layout-geometry.md:3-9 | | Supports the approach | Anything that affects geometry must be a number in the table |
| Base geometry first, animated projection second: layout box, prompt box, hit area, occlusion bounds, visual residual | drafts/layout-geometry.md:11-25 | Separate outputs | Maps directly | |
| Mutually dependent sizes (image height depends on caption height, which depends on image width) with a tiny bounded solve | drafts/layout-geometry.md:62-81 | Fixed-point iteration, 1-3 passes | Needs reformulation | Unroll the passes, or compute all candidates (1, 2, 3 caption lines) and select |
| Continuous resize within a mode shouldn't kick a spring residual; mode changes should | drafts/layout-geometry.md:83-100 | Select on a "mode changed" bit | Maps directly | |
| Sticky user banner: `userTop = clamp(rowTop, 0, rowBottom - userHeight)` | hn.js:439-440 | Clamp | Maps directly | A sticky header is one clamp |
| Submission header shrinks with scroll, piecewise linear, with a rubber band feel at the top and a squash at the bottom | hn.js:272-308 | Piecewise linear function of scroll position | Maps directly | min, max, select |

### 2.6 Text

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| pretext: `prepare()` once per text, `layout(prepared, width)` on resize | ui.md:307, pretext README | Segmentation and canvas measurement, then a greedy line walk over cached widths | `prepare` is outside; `layout` needs reformulation | Width thresholds per paragraph, computed in the prepare step. Height at a runtime width is a count of thresholds (section 3.5) |
| Prompt clamped by CSS `-webkit-line-clamp` (2 or 999) in a fixed 44px box, quote mark painted by CSS `::before` | index.ts:91-92, 564-580; index.html `.prompt` | No measurement | Maps directly (constants) | drafts/layout-geometry.md:27-60 calls this split a source of bugs. The vibescript photo-gallery port measures the `❝` prefix with pretext's `break: 'never'` (demos/photo-gallery/prompt-layout.ts:80-87) |
| Append all comments at load, read each `clientHeight` | hn.js:179-224 | Platform layout read | Outside | Heights as cells. Never re-measured on resize |
| Search highlight rectangles from `Range.getClientRects()`, caret under the pointer from `caretRangeFromPoint`, link under the pointer from `elementFromPoint` | hn.js:512-560, 590-635 | Native layout queries | Outside | With pretext, fragment rectangles and caret offsets could come from line tables, but those tables depend on width, so they become staircases too |
| Fuzzy search: query characters joined with `\S*?` into a case-insensitive regex, `matchAll` over cached comment text | hn.js:562-571 | String processing | Outside | Match ranges as `{start, end}` offsets, converted to line index and x range by a text layout step |
| "Strings are the `any` of data"; carry `{start, end}` views | engineering.md:53-58 | | Supports the approach | Text ranges as numbers are what can enter the table |
| Discrete line breaks need an explicit resize policy: snap, freeze until resize settles, crossfade | drafts/layout-geometry.md:102-112 | Select on bits | Maps directly | |

### 2.7 Hit testing

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Iterate bounding boxes and check containment | ui.md:311-313 | Per-item map of four comparisons | Maps directly | IndirectOS `emitRectangleHit` (window-manager.ts:1566-1583) |
| Topmost box first when animated, scaled boxes overlap; return the first hit | index.ts:274-286 | First-match search with early exit, in priority order | Needs reformulation (known) | Per-item bits, then `emitFirstActive` (logarithmic depth, [patterns.md](../../../patterns.md#findindex-when-passing-items-can-be-anywhere-and-keeping-the-best-score-so-far)) or IndirectOS's rank chain `emitFrontmost` (window-manager.ts:1532-1564) |
| First hit among non-overlapping grid targets | index.ts:304-310, 446-454 | First-match search | Maps directly | Containment bits of non-overlapping boxes are already at most one-hot, so no selection is needed |
| First row containing the pointer, with `break` | hn.js:326-342 | First-match search over sorted intervals | Needs reformulation (cheap) | One-hot as `[y >= top_i] - [y >= top_(i+1)]` (section 3.3) |
| Hit test the stable destination `dest` instead of the moving `pos`, but use `pos` for drag targets | ui.md:315 | Choice of which cells to compare | Maps directly | Both are cells. index.ts tests clicks against the rectangles presented in the previous state (index.ts:273) and hover against the new targets (index.ts:446) |
| "Views should be decoupled from their hitboxes": HN hit-tests natural heights, not animated heights, to avoid a shrink/grow feedback loop | hn.js:311-313 | Choice of cells | Maps directly | |
| Ancestor search `while (ancestor > 0 && data[ancestor].indent > indentPointed) ancestor--` | hn.js:333 | Backward first-match search over static tree data with a runtime key | Needs reformulation | Precomputed `ancestorOf[row][level]` and a gather (section 3.4) |
| 1D mode: left and right click regions, bounded by the focused index | index.ts:287-292 | Two comparisons and integer bounds | Maps directly | |

### 2.8 Animation

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Numerical spring, semi-implicit Euler, 4ms steps | Animation.md:35-67, index.ts:37-75 | Integration step repeated a runtime number of times | Needs reformulation | Selected matrix powers; one runtime 2x2 matrix shared by all springs with the same constants (section 3.2) |
| End the spring when mostly done (speed and distance below 0.01), then snap to the destination | Animation.md:64-70, index.ts:67-70 | Comparisons and select | Already expressed | `emitSpring` active bit (numeric-ui-core.ts:1199-1219) |
| Non-finite guard inside the step loop | index.ts:61-65 | `Number.isFinite` | Outside the numeric contract | Declared finite ranges replace the guard |
| `stillAnimating` over all springs | index.ts:330, 521 | Reduction (or) | Already expressed | IndirectOS `animationActive` |
| Position and velocity deltas added before stepping: scroll compensation, edge rubber band velocity | index.ts:37-49, 477-480, 516 | Affine | Maps directly | |
| Reduced motion: go to end | index.ts:50-53, 343 | Select | Maps directly | Media query bit as a cell |
| Closed-form springs for all damping regimes; exponential decay `x(t) = x0 * e^(-kt)` | Animation.md:10-18, 90-95 | Transcendental functions of time | Needs reformulation | At 4ms granularity, products of precomputed constants selected by the bits of the step count. Arbitrary `t` needs exp, sin, cos |
| Several moving items that affect each other (repulsion, collision) need numerical stepping | Animation.md:16 | Pairwise forces per step | Maps directly for a bounded count | n² pair terms per step. The matrix-power shortcut doesn't apply because the system is nonlinear |
| Per-frame easing `row.height += (final - row.height) / 5`, scroll smoothing `0.55 * previous + 0.45 * real` | hn.js:249, 373-375, 388 | One step per frame, frame-rate dependent | Maps directly | Animation.md:95 warns that per-frame multipliers depend on frame rate |
| Flick that snaps to a corner: decay rest position, choose the corner from it, sum of two springs | Animation.md:82-88 | Affine rest position; argmin over 4 corners; two springs | Maps directly | `emitArgmax` over negated distances |
| Spring tightening, versus keeping the image in the scroll view's local coordinates | Animation.md:78-80 | Coordinate choice | Maps directly | The doctrine's fix is a coordinate choice, which costs nothing in a circuit |
| Animations derived from state, e.g. a bar that darkens as a function of scroll position | Animation.md:23 | Closed-form function of current state | Maps directly | |
| Predictive keyframes: simulate ~200 steps ahead with a pure `simulate()`, hand the frames to Web Animations | Animation.md:97-142 | Repeated pure step; platform side effect | Loop needs reformulation; keyframe emission is outside | The circuit is already a pure `simulate()`. With matrix powers, future frame i is an independent evaluation at step count i, so 200 predictions are one batch |

### 2.9 Scrolling

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| Read `scrollTop`, which is late, rounded, and never negative; smooth it over frames | Scrolling.md:13-27, hn.js:242-260 | Platform read, then affine smoothing | Read is outside; smoothing maps directly | Cells: current read, previous smoothed value, previous delta |
| Occlusion culling with conservative margins for translucent browser chrome | index.ts:542-553, hn.js:441 | Per-item comparisons | Maps directly | 222 boxes: 5,772 ops, 5 layers (section 3.6) |
| Scroll anchoring: compare with the stored read-back value, pick the first item below the scroll position, adjust by that item's movement, `scrollTo`, read back | Scrolling.md:44-60, index.ts:456-464 | Equality check; first-match search over sorted positions; gather; platform side effect | Needs reformulation (cheap) | Positions are sorted, so the anchor is a count of rows above the threshold; the delta is a gather. Outputs: adjusted scroll position and a changed bit. `scrollTo` and the read-back stay in JS |
| Scroll extent through a dummy placeholder's height | index.ts:245-248, 587; hn.js:500 | Output number | Maps directly | Bottom of the last row |
| Scroll to the dismissed photo if it isn't fully visible, and compensate springs so boxes don't jump | index.ts:423-429, 516 | Comparisons and affine | Maps directly | |
| On Safari, bounce the whole scroller instead of the content during rubber banding | hn.js:261-264, 305-307 | max, relu | Maps directly | |
| Recreating Apple scroll physics: 0.99 per millisecond decay, exponential rubber band | Scrolling.md:80-86 | Per-millisecond integration | Needs reformulation | The same selected-power trick as springs |
| Safari body as the scroll container, capture-mode scroll listener, user agent detection | Scrolling.md:98-110, index.ts:115-124 | Platform configuration | Outside | One bit for which element to read |

### 2.10 Depth

| Technique | Where | Shape | Status | What crosses, or reformulation and cost |
| --- | --- | --- | --- | --- |
| DOM order as paint order; one global `Z.ts` with `d++` constants; local stacking contexts | z-index-depth-management.md:19-81 | Constants and CSS configuration | Maps directly | |
| Focused box on top: `zIndex = boxes.length + 1`, else `i + 1` | index.ts:564-575 | Select | Maps directly | |
| Window stacking order that changes on focus | IndirectOS | Permutation update | Already expressed | Stack one-hot matrix and `emitFrontmost` |

### 2.11 Engineering preferences that bear on the approach

| Preference | Where | Relevance |
| --- | --- | --- |
| Even worst-case latency; branchless, uniform-cost systems like shaders | engineering.md:78 | Every-item-every-frame evaluation is what the doctrine asks for |
| O(n²) is fine when n is bounded by the domain, not by user data | engineering.md:99 | A triangular affine layer (a one-layer prefix sum) has n²/2 weights: 435 for 30 HN rows, 499,500 for 1,000 rows |
| Avoid caching, except the DOM and truly expensive computations with stable input identity | engineering.md:122-129 | pretext's prepare step is that kind of exception, and its numbers are what should enter the table |
| Model the dependency order directly, in one place | engineering.md:111-120 | Same as a circuit's topological order |
| `@fit` range annotations on parameters and return values | index.ts:22-23, 40, 100-104, 134-138 | Finite ranges are what gather lowering and exact comparisons need (README TODO: "Declare finite ranges in the production builders") |

## 3. Reformulations, with measurements

### 3.1 Accumulating positions

Both sites accumulate positions one item at a time: gallery row tops (index.ts:412), the 1D strip's `currentLeft` (index.ts:469-497), and HN row tops (hn.js:497). The trace compiler compiled the gallery's 1D slice into 1,580 layers "because it accumulates positions sequentially through 221 photos" and noted that "a parallel prefix sum would change rounding order, so it is not automatically interchangeable under this exactness policy".

`measure.ts` compares five constructions. Heights look like HN rows (40px plus 14px per line, 1 to 30 lines), and 20% of rows are mid-animation with fractional heights. Drift is the maximum absolute difference between the circuit's row tops and float64 sums of the same FP32 heights, over 40 trials (5 trials for 1,000 rows and above).

| Rows | Construction | Live ops | Layers | Stored weights | Max drift (px) |
| ---: | --- | ---: | ---: | ---: | ---: |
| 30 | sequential `roundAffine` chain | 30 | 30 | 58 | 0.00065 |
| 30 | one triangular affine layer | 30 | 1 | 435 | 0.00067 |
| 30 | Brent-Kung scan | 79 | 8 | 127 | 0.00047 |
| 221 | sequential `roundAffine` chain | 221 | 221 | 440 | 0.0154 |
| 221 | sequential builder `affine` chain | 221 | 73 | 658 | 0.0138 |
| 221 | one triangular affine layer | 221 | 1 | 24,310 | 0.0141 |
| 221 | Kogge-Stone scan | 1,726 | 9 | 3,230 | 0.0056 |
| 221 | Brent-Kung scan | 648 | 14 | 1,074 | 0.0088 |
| 1,000 | sequential `roundAffine` chain | 1,000 | 1,000 | 1,998 | 0.066 |
| 1,000 | one triangular affine layer | 1,000 | 1 | 499,500 | 0.061 |
| 1,000 | Kogge-Stone scan | 9,967 | 11 | 18,933 | 0.021 |
| 1,000 | Brent-Kung scan | 2,980 | 18 | 4,959 | 0.030 |
| 4,000 | sequential `roundAffine` chain | 4,000 | 4,000 | 7,998 | 0.74 |
| 4,000 | Kogge-Stone scan | 47,893 | 13 | 91,785 | 0.083 |
| 4,000 | Brent-Kung scan | 11,976 | 22 | 19,951 | 0.14 |

The last row top was about 56,000px at 221 rows, 237,000px at 1,000 rows, and 930,000px at 4,000 rows. The 4,000-row case is already past the ~500,000px where iOS Safari can crash (Scrolling.md:100).

Observations:

- Reordering the sums changes the result by far less than a pixel at every realistic size, and the balanced scans drift less than the sequential chain. A balanced sum adds numbers of similar magnitude at each level, while the chain keeps adding small heights to a large running total.
- The triangular affine layer is the plain matmul answer: row tops are a lower triangular matrix times the heights, in one layer. It costs n²/2 weights, which is fine for HN's 30 rows and wasteful for the gallery's 221.
- Brent-Kung is the practical default: about 3n ops, 5n weights, and 2 log₂ n layers.
- The ordinary builder `affine` chain partly composes, giving 73 layers for 221 rows instead of 221. That matches the known behavior that affine wires get inlined into their consumers.

### 3.2 Springs with the doctrine's timing

The doctrine uses fixed 4ms steps, a variable number of steps per frame, and a cap (Animation.md:40-74). index.ts follows this but loops `steps` times without the cap (index.ts:513 feeding the loop at 54-66). IndirectOS instead runs exactly 4 substeps of `min(frameTime - previousFrameTime, 32ms) / 4` (window-manager.ts:402-416, numeric-ui-core.ts:1165-1220). The IndirectOS trajectory therefore depends on frame rate, and after a stall longer than 32ms the animation slows down instead of catching up. The trace compiler rejected index.ts's spring loop outright because of its unbounded runtime iteration count.

Reformulation: on displacement `x = pos - dest` and velocity `v`, one semi-implicit Euler step is linear: `v' = -k*dt*x + (1 - b*dt)*v` and `x' = x + dt*v' = (1 - k*dt²)*x + dt*(1 - b*dt)*v`. So N steps is the 2x2 matrix M to the power N, applied to (x, v). With the bits `b_j` of the step count, M^N is the product over j of `b_j ? M^(2^j) : I`. When stiffness and damping are constants, each M^(2^j) is a constant matrix, and each selected factor `I + b_j * (M^(2^j) - I)` is affine in its bit. When stiffness and damping are editable source cells, as in IndirectOS, the powers need runtime squaring at 8 products per squaring.

Measured in `measure.ts` and `gallery-springs.ts`:

| Construction | Live ops | Layers | Stored weights | Notes |
| --- | ---: | ---: | ---: | --- |
| One spring, 9 step bits (0..511 steps), constant stiffness 290 and damping 30, chained selects | 112 | 41 | 225 | Includes extracting the bits. Max position drift against float64 iteration over 20,000 random states and step counts: 0.00028px. Largest matrix entry: 6.86 |
| IndirectOS `emitSpring`, 4 substeps | 78 | 45 | 168 | Frame-rate dependent timing |
| All 1,332 gallery springs sharing one runtime matrix, with per-spring settle snapping | 40,243 | 36 | 80,494 | About 219µs per frame through `createTensorEvaluator` on the CPU |

In the shared version, the matrix is computed once per frame from the global step count by a balanced product of the 9 selected factors. Each spring then costs 4 products and 2 affine ops to step. Most of each spring's cost is the settle snap (absolute values, clamp, select), not the step. Snapping all of a box's springs by one bit, or skipping snapping for springs that don't need an exact rest, would cut that.

In matmul terms, a bank of linear springs with shared constants is one sparse matmul whose repeated 2x2 block is computed at runtime. That's the approach's primitive, used the way ML uses shared weights across instances. Nonlinear systems (interacting springs, collisions) don't get this shortcut.

The same trick covers exponential decay at 4ms granularity, as a scalar product of `e^(-k * 0.004 * 2^j)` constants selected by bits, and Apple's per-millisecond decay (Scrolling.md:84). The spiral-of-death cap becomes the bit width.

### 3.3 Hit testing without early exit

There are three situations, from most to least expensive:

- Overlapping boxes with a priority, like index.ts's animated boxes (index.ts:274-286) or IndirectOS windows: compute per-item hit bits, then run the `emitFirstActive` tournament (logarithmic depth) or a rank chain like `emitFrontmost`.
- Non-overlapping boxes, like index.ts's grid targets (index.ts:304-310): at most one containment bit is set, so the bits are already the answer.
- Sorted non-overlapping intervals, like HN rows and grid rows: the one-hot "pointer is in row i" is `[y >= top_i] - [y >= top_(i+1)]`, one affine layer after the comparisons. The row index is the sum of i times each one-hot bit.

`hn-hit.ts` builds the hn.js hit test (hn.js:318-355) for the 30-comment thread (indents 0..7) as a circuit. It covers the row under the pointer, gutter versus comment (`floor(pageXLocal / 24) <= indent`), the ancestor index, and the 30 shrink bits (`i > ancestor && i < row` while pressing a gutter). Cost: 688 ops (511 live), 13 layers, 1,578 stored weights. It matched the hn.js logic in all 20,000 random trials, with pointer positions at quarter pixels, random heights, and random press state. Pixel comparisons use the rounding boolean on a difference scaled by 1024, which resolves to 1/2048px. Integer comparisons such as `i > ancestor` use the exact `relu(d + 1) - relu(d)` form from expressions.md.

### 3.4 Tree walks over static structure

HN's tree structure (the indents) never changes at runtime; only heights and the pointer do. So the tree walks can become tables in a prepare step:

- The ancestor search (hn.js:333) becomes `ancestorOf[row][level]` for levels 0..7, which is 240 constants for 30 rows. At runtime, ancestor = sum over levels of `levelOneHot[level] * (sum over rows of rowOneHot[row] * ancestorOf[row][level])`. The inner sums are affine in the row bits, then there are 8 products.
- Gutter bottoms (hn.js:480) loop over the following rows while their indent is deeper. The subtree's last row is static, so a gutter bottom is the difference of two prefix sums at static indices. That's plain wiring, with no gather.

A tree that changes at runtime, e.g. collapsing threads, would need runtime gathers, or permutation bits like IndirectOS's stack.

### 3.5 Text height as a staircase of width thresholds

The argument: pretext breaks lines greedily over summed segment widths. With a wider width, or a later start position, a line never ends earlier, so the line count can only drop as width grows. A paragraph's line count at width w is then its line count at the widest width plus the number of thresholds greater than w, where the k-th threshold is the width at which the count drops by one. The prepare step can find the thresholds by bisection with `measureLineStats`. The pretext README already suggests the same kind of search over widths for shrinkwrap.

`staircase.ts` checks this with fake glyph widths, mocking the canvas the way pretext's own tests do, using `prepareWithSegments` and `measureLineStats`:

- 81 HN paragraphs from both threads, split at `<p>`, at comment widths from a 375px to a 1200px container minus indent and gaps; and all 222 gallery prompts with the `❝ ` prefix, at widths 100..1100.
- Sweeping in 0.25px steps found 0 cases where the line count went up with width. There were 1,605 thresholds in total, at most 22 in one paragraph. Rebuilding the count from the thresholds matched `measureLineStats` at all 60,600 random widths tried.

What crosses the boundary, per paragraph: the threshold widths and the line count at the widest width, plus line height and paragraph gaps. A comment's width is affine in the container width, and its height is `lineHeight * (baseCount + number of thresholds above the width) + gaps`. For the HN thread that's a few hundred comparisons, about 5 ops each in the rounding form, over a handful of layers. No line breaking happens in the circuit.

Open questions: real fonts measured by canvas in a browser; `rich-inline` flows (links, italics, code, `break: 'never'` items); `pre-wrap`; soft hyphens; `keep-all`; breaking inside long words like the URLs in HN comments. Painting line fragments also needs each line's end offset as a function of width. Those are staircases too, but one per line, so painting costs much more than heights. Heights are what both sites need for layout.

### 3.6 Comparisons: rounding versus the sign cascade

The circuit has two ways to compare numbers:

- The rounding boolean on a scaled difference, e.g. `boolean(clamp01((a - b) * 1024 + 0.5))`. It costs about 5 ops and resolves to 1/2048px, as long as the scaled difference stays under 2^24, where `clamp01` is exact.
- The sign cascade (tricks.md, now expressions.md), which is exact for any finite difference but costs about 25 ops and 25 layers.

The trace compiler uses the cascade everywhere, so its occlusion slice for 221 boxes costs 25,416 ops and 32 layers. Occlusion for 222 boxes with the rounding form costs 5,772 ops and 5 layers (`gallery-springs.ts`). Neither site's UI decisions need sub-pixel exactness. The one known exactness failure, the column count at width 1732, comes from FP32 rounding in the reciprocal earlier in the calculation, so both comparison forms see the same already-rounded value.

### 3.7 Small structural choices, e.g. column count 1..7

The column count changes which items share a row. The trace compiler compiled one specialization per column count and selected among them. Its 2D layout slice cost 24,894 ops and 600 layers under its exactness policy. A cheaper split for the same idea:

- Before any per-item work, select `boxMaxSizeX` by the column one-hot. The aspect ratio branch at index.ts:402-405 is fixed per photo, so `sizeX_i = min(w_i, c_i * boxMaxSizeX)` where `c_i = min(1, factor_i * ar_i)` is a per-photo constant. That's one affine op and one min per photo, shared by all variants.
- Per variant: a static max tree for each row's height (depth 3 or less), a Brent-Kung scan over rows, and affine x and y per item.
- Only x and y differ across variants, so the select costs 222 × 2 × 7 masked products, about 3,100.

### 3.8 Several events of one kind in one frame

The doctrine keeps the latest value where only the latest matters, and accumulates where every occurrence counts (ui.md:119). IndirectOS holds one slot per event kind and merges down, move, up in a fixed order (window-manager.ts:684-697). A down, a move, and an up arriving in one frame work, but two moves collapse into the last one. The event-window lab demo keeps every queued move, because moving outward past the drag threshold and back must still cancel a click. Options:

- A fixed-capacity queue of K events in the table, processed by K unrolled stages. Depth grows with K.
- Run the circuit once per queued event, without advancing time, then once for the frame. Cost grows with the number of events; depth doesn't.
- Summarize in JS, e.g. the maximum distance from the press point since the last frame. The circuit stays single-pass, but some interpretation moves into the event callback, which the doctrine discourages (ui.md:104).

## 4. chenglou.github.io/index.ts as a circuit

### Frame phases

| Phase | Lines | What the JS does | Circuit version |
| --- | --- | --- | --- |
| Take pending events | 335-337 | Swap `pendingEvents` for an empty record | Latch cells, zeroed in next source |
| DOM reads | 339-346 | `clientWidth`/`clientHeight`, reduced-motion media query, scroll x and y (body on Safari, window elsewhere), focused photo from popstate or by scanning ids against `location.hash` | JS writes cells. The id scan stays in JS and crosses as an index plus a present bit |
| Keys | 350-356, 370-375 | `KeyA` debug stepping; Escape clears focus; ArrowLeft/ArrowRight move focus with clamping, or focus the first photo when none is focused | Decoded key bits; select chain; integer min/max (exact for integers) |
| Pointer | 358-367 | Pointer is the click position, overridden by a later mousemove; local = client + scroll | Select, affine |
| Click | 377-392 | If the target is a `FIGCAPTION`, select the prompt text. In 2D mode, hit-test presented rectangles from the previous state, topmost first, accounting for scale around the center. In 1D mode, left and right regions | Prompt click as a geometry hit test against the prompt rectangle, or an "on prompt" bit from JS. 222 hit bits and a first-active tournament. 1D regions as comparisons |
| Column count | 395, 105-113 | `cols` 1..7 and `boxMaxSizeX` | Threshold bits into a one-hot, seven constant reciprocals (section 3.7) |
| First layout pass | 397-416 | Per photo size from the aspect ratio; row height as the max over the row; row tops accumulated | Per photo min; per variant max trees and a Brent-Kung scan |
| 2D targets | 422-445 | After dismissing 1D mode, scroll so the dismissed photo is fully visible. x from `i % cols`, y centered within the row | Gather of the row top at the dismissed photo through a static item-to-row mapping per variant; comparisons; affine per item; select across variants |
| 2D hover | 446-454 | First hit among new targets; cursor `zoom-in`; magnet offset `(pointer - center) / 40`; scale 1.02 | Containment bits (already at most one-hot); per-item products by the hover bit |
| Anchor | 455-464 | Anchor's y from the previous anchor index. On resize, keep the anchor in place. When scrolled far, search the leftmost column for the first photo whose bottom is below 20% of the window | Gather by the anchor index; comparisons; row tops are sorted, so the new anchor is `cols * count of rows above the threshold`, capped at the last full row |
| 1D targets | 465-509 | Start `currentLeft` left of the screen by summing widths of photos before the focused one, then walk all photos; focused photo centered; photos after it start at the right edge | One Brent-Kung scan over per-photo widths; gathers of the prefix at `focused` and `focused + 1`; per photo select by `i < focused`, `i == focused`, `i > focused` (exact integer comparisons). Replaces the trace compiler's 1,580 layers with roughly 20 |
| Edge rubber band | 477-480 | Velocity kick when pressing ArrowLeft on the first photo or ArrowRight on the last | Key bits times boundary bits |
| Animation | 511-523 | `steps` from the frame time with no cap; 6 springs per photo; scroll compensation on y; reduced motion goes to end | Shared matrix powers (section 3.2): 40,243 live ops, 36 layers for all 1,332 springs |
| Commit | 525-539 | New immutable state sharing unchanged boxes with the previous one | Next-source cells |
| DOM writes | 541-587 | Occlusion with browser chrome margins; width, height, transform, brightness and blur (blur only for the focused photo and its neighbors), z-index, prompt clamp mode, full-resolution `img.src` once the focused photo stops animating, attach and detach; cursor, body overflow, placeholder height | Occlusion bits (5,772 ops, 5 layers). Neighbor bits are the focused one-hot shifted by one (affine). Outputs per box plus global outputs. Strings and node attachment stay in JS |
| Side effects | 589-605 | Select prompt text via `Range`; `scrollTo(adjustedScrollTop)` if changed; `pushState` with the new hash | Outputs: prompt index plus bit, adjusted scroll position plus changed bit, focused index plus route changed bit |

### Source table and outputs

The source table would hold:

- Viewport size, scroll x and y, reduced-motion bit, and the integer step count (from JS `Math.floor`), or frame time plus `animatedUntilTime` with a bounded floor in the circuit.
- Latches: Escape, ArrowLeft, ArrowRight, KeyA bits; click active, client x and y, local x and y, "on prompt" bit; mousemove active and x, y; popstate active; route focused index and a present bit.
- State: focused index and a present bit (or a 223-way one-hot), anchor index, pointer x and y, previous window width, previous scroll y, `animatedUntilTime`, debug timestamp.
- Springs: 222 photos × 6 springs × position and velocity, about 2,664 cells. Destinations are recomputed every frame from the targets.
- Photo widths, heights, and aspect ratio reciprocals, which fold into weights as constants.

Outputs: per photo width, height, translate x and y, scale, brightness, blur, z-index, visible bit, focused bit, and "load full resolution" bit. Globally: cursor code, overflow bit, placeholder height, adjusted scroll position and its changed bit, focused index and its changed bit, prompt selection index and its bit, the animating bit, and the next-source cells.

### Sequential dependencies

- Row tops over rows (index.ts:412) and the 1D strip's left edges (index.ts:469-497): prefix scans plus gathers at the focused index.
- The spring loop over `steps` (index.ts:54-66): matrix powers.
- The anchor search loop (index.ts:459-463): a count, because row tops are sorted.
- Hit test loops with early return (index.ts:276-285, 305-308): a tournament for overlapping presented rectangles, containment bits for grid targets.
- Commit order within the frame is already top-down, so no hidden dependencies remain.

### Text measurement

index.ts measures no text. The prompt box is a fixed 44px, a magic number that "doesn't show the 3rd line nor cuts the 2nd line on safari, mobile safari and chrome" (index.ts:92). CSS `-webkit-line-clamp` truncates the text, and CSS `::before` paints the quote mark. A circuit version needs no text measurement as long as that design stays. Tight caption heights would use the staircase thresholds from section 3.5, at `boxMaxSizeX` minus padding.

### Divergences noticed while reading

- No spiral-of-death cap at index.ts:513, while ui.md:64 and Animation.md:74 cap the step count at 300.
- Clicks hit-test the rectangles presented in the previous state, including scale around the center (index.ts:273-286), and hover hit-tests the new targets (index.ts:446). ui.md:315 recommends destinations for clicks. The comment at index.ts:273 states the choice explicitly.
- `readFocused` scans all 222 ids against the URL hash every frame (index.ts:176-180, 346).

### Size estimate

Measured: springs 40,243 live ops and 36 layers; occlusion 5,772 ops and 5 layers. Estimated: layout with seven variants plus the 1D scan and gathers at 10,000-20,000 ops; hit testing at 2,000-4,000 ops. The total would be roughly 60,000-70,000 live ops. The step-matrix product only depends on the step count, so it runs in parallel with layout, and the per-spring work adds about 10 layers after the targets exist. The expected depth is roughly 40-60 layers, and extrapolating the springs measurement gives roughly 250-300µs per frame on the CPU evaluator. For comparison, IndirectOS today is 201 sources, 6,146 ops (5,253 live), 192 layers, 11,598 weights, and about 38µs per frame (`bun lab/runtime-cost/report.ts`). The trace compiler slices of a June 2026 revision of this file were much deeper under their exactness policy: 2D layout 600 layers, 1D layout 1,580 layers, occlusion 32 layers.

## 5. nicer-hacker-news/hn.js as a circuit

### Initialization and events

- hn.js:168-178 builds per-thread state and a DOM skeleton for each of the 32 threads.
- hn.js:179-205 creates user and comment nodes for the current thread with `innerHTML` at a container width from `window.innerWidth`, then hn.js:210-224 reads every comment's `clientHeight`. This is the thread's only text measurement. It never runs again, so resizing changes widths without changing heights.
- Events (hn.js:121-166) write the pointer state (`mouseup`, `touchend`, `contextmenu` set "up"; `mousedown` sets "first down"), page coordinates, `clicked`, and `copied`. The `copy` handler builds clipboard content inside the event, because the browser requires it.

### Frame phases

| Phase | Lines | What the JS does | Circuit version |
| --- | --- | --- | --- |
| DOM reads | 239, 247 | `innerHeight`, `innerWidth`, `devicePixelRatio`, scroller `scrollTop` | Cells |
| Scroll smoothing | 243-260 | If the previous delta exceeded 0.01, mix 55% previous and 45% real and keep rendering; otherwise snap | Comparison, select, affine; keep-rendering bit |
| Rubber band cap | 264 | `scrollTopCap = max(0, scrollTop)` | relu |
| Vertical sizing | 266-309 | Sum natural heights. If everything fits, grow the submission header; otherwise shrink it with scroll, piecewise linear, and squash the scroller when scrolled past the end | Reduction (sum); min, max, select chain |
| Pointer region and row | 314-343 | Container width clamp; regions for previous thread, next thread, current thread; first row containing the pointer; gutter versus comment; ancestor search | Measured circuit, 511 live ops, 13 layers (section 3.3) |
| Shrink state | 345-355 | Rows strictly between ancestor and pointed row switch to "shrink" while pressing a gutter | Shrink bits into next source |
| Peek | 357-376 | Sum natural heights of shrinking rows after the ancestor; the ancestor's top from a sum up to the ancestor; ancestor height capped by scroll; peek-up target clamped; ease peek-up by 1/5 per frame | Masked sum (30 products); prefix sum gathered at the ancestor; clamp; one affine step per frame |
| Row heights | 377-392 | Target: ancestor height for the ancestor, 0 for shrinking rows, natural otherwise; ease each by 1/5; sum the gap left by shrinking rows; keep rendering if any row moved | Per row select and affine; reduction; or-reduction bit |
| DOM writes 1 | 396-433 | Wipe the comments display; resize the canvas for the device pixel ratio; container, submission, search, scroller rectangles; submission fade mask | Numbers out. The fade opacity `1 - submissionHeight / scrollerPeekUp` (hn.js:413) divides by a runtime value, and gives -Infinity when `scrollerPeekUp` is 0. It's cosmetic: JS can compute it while formatting, or the fade can use a formula without division |
| Rows | 434-470 | Accumulate row tops over animated heights; sticky user banner as a clamp; visible range; banner emphasis for the ancestor; opacities; comment top, height, fade size; re-append visible nodes | Prefix scan (30 rows: one triangular layer with 435 weights, or Brent-Kung with 8 layers and 127 weights); clamp; comparisons; affine outputs. JS re-appends nodes from visibility bits |
| Gutters | 472-495 | Gutter top, piecewise on small distances; gutter bottom by summing the heights of following deeper rows; draw a canvas line | Select chain; difference of prefix sums at static subtree ends (section 3.4); JS draws from numbers |
| Placeholder | 500 | Scroll extent | Output |
| Temporary selection toggles, DOM read 2 | 502-538 | Turn on `userSelect` for the pointed row, call `caretRangeFromPoint`, update custom selection nodes and offsets, capped to one row | Outside: native caret query and DOM node identity |
| Cursor | 540-560 | `elementFromPoint` finds links: pointer cursor, and `window.open` when pressed and released on the same link. Gutter cursor `row-resize` when the ancestor's top is above the scroll position or the ancestor isn't the direct parent. Resize cursors for previous and next thread regions | Link detection outside (or link rectangles from pretext tables). The gutter condition is a prefix sum gathered at the ancestor plus an integer comparison. Cursor code output |
| Search | 562-571 | Dim the scroller; fuzzy regex over each comment's text | Outside: string processing |
| Highlights | 572-640 | Walk text nodes to convert match offsets to DOM positions; `getClientRects()` per match, cleared on the canvas with clamps; selection rectangles drawn as first line, middle block, last line | Outside: DOM text geometry. The clamps and the three-rectangle shape could come from the circuit if line geometry were in the table |
| Prepare next frame | 651-659 | Reset `clicked` and `copied`; advance pointer state; schedule another frame if needed | Next-source cells, keep-rendering bit |

### Sequential dependencies

- Sum of natural heights (hn.js:280): reduction.
- First row containing the pointer, with `break` (hn.js:328-341): difference of step bits.
- Ancestor `while` loop (hn.js:333): static table and gather.
- Ancestor top as a sum up to the ancestor (hn.js:366): prefix sum gathered at the ancestor.
- Sum of shrinking rows after the ancestor (hn.js:363-364): masked sum.
- Row top accumulation over animated heights (hn.js:434-497): prefix scan.
- Gutter bottom inner loop (hn.js:480), which costs O(rows × subtree size): difference of prefix sums at static subtree ends.
- Text node walk and `advance()` over string offsets (hn.js:578-595): outside.

### Text measurement

hn.js relies on the DOM for all text geometry:

- `comment.clientHeight` once at load (hn.js:213), for comments rendered with `innerHTML` (paragraphs with 8px top margins, links, italics).
- `Range.getClientRects()` for search matches and selection (hn.js:596, 614).
- `caretRangeFromPoint`, or `caretPositionFromPoint` on Firefox (hn.js:84-89, 515), for selection endpoints.
- `elementFromPoint` for links under the pointer (hn.js:543).

The vibescript port (vibescript's `demos/nicer-hacker-news/`) replaces the height measurement with pretext rich-inline layout. It lays out each comment again whenever its width changes (index.ts:316-323, hn-comment-layout.ts) and separates row hit geometry from visual geometry (hn-thread-layout.ts: `layoutHNRowHitGeometry` and `layoutHNThreadVisualGeometry`).

### What a circuit version contains

- Sources: pointer page x and y, "pointer down" and "first down" bits, `clicked` bit, window width and height, raw scroll position; state for the smoothed scroll position, previous delta, peek-up amount, per-row animated height (30), and per-row shrink bit (30). Natural comment heights come either as measured cells or as staircase thresholds per paragraph, with the height computed in the circuit from the comment width.
- Circuit: scroll smoothing, header sizing, region and row hit test with gutter and ancestor, shrink bits, peek sums and easing, row height easing, row top scan, sticky banners, gutter extents, visibility bits, cursor code for the gutter and thread regions, and the keep-rendering bit.
- Outputs: container, submission, search, and scroller rectangles; per row banner top, height, opacity, emphasis bit, text opacity, comment top, height, fade size, visible bit; per row gutter left, top, bottom, emphasis, visible bit; placeholder height; cursor code; next-source cells.
- Left in JS: `innerHTML` content, node re-append, canvas drawing, native caret and selection, regex search and highlight rectangles, the copy handler, link detection and `window.open`.

The measured hit-testing part is 13 layers. With a triangular layer for the 30 row tops, the whole thread is probably under 30 layers and a few thousand ops. That's an estimate, not a measurement.

## 6. What crosses the boundary, as numbers

Into the source table:

- Viewport width and height, device pixel ratio, scroll positions as read back.
- Frame time and previous frame time, or an integer step count.
- Media query bits (reduced motion), platform bits (Safari scroll container).
- Pointer latches: active bit and coordinates per kind (down, move, up, click), timestamps where input timing matters.
- Decoded key bits (Escape, arrows, debug keys).
- Route tag one-hot and payload indices, e.g. the focused photo index parsed from the URL hash.
- Results of DOM identity checks that aren't replaced by geometry, e.g. an "on prompt" bit.
- Text geometry from pretext's prepare step: width thresholds per paragraph, line heights, gaps. Later, perhaps line end offsets per staircase step, and match ranges as offsets.
- Media state bits: decoded, playing.
- Event-time results of JS-only arithmetic, e.g. hash-based random destinations, or flick velocity at release.

Out of the circuit:

- Per node: geometry, transforms, opacity, brightness and blur amounts, z-index, focus and mode bits.
- Visibility bits for creating, attaching, and detaching nodes (domCache in JS).
- Cursor code, overflow bit, placeholder height.
- Side effect requests: adjusted scroll position with a changed bit, route index with a changed bit, selection target index, "load full resolution" bit.
- Canvas drawing numbers: line endpoints, highlight rectangles.
- The keep-rendering bit.
- Next-source cells.

## 7. Prototype ideas

- Doctrine spring bank: replace IndirectOS's `emitSpring` with fixed 4ms steps via a shared runtime matrix per stiffness and damping group. Test retargeting, stalls of 2 seconds, and settle snapping, and compare ops and layers with the current springs. This would show whether the matmul primitive gives frame-rate-independent, correctly catching-up springs at similar or lower cost.
- HN thread in one circuit: port hn.js's render path for the 30-comment thread. Row tops as a prefix scan, sticky banners as clamps, gutter extents from static subtree tables, peek easing, visibility bits, cursor code, with comment heights from pretext staircase thresholds so resizing works without JS text layout. JS keeps canvas drawing, node attachment, native selection, and regex search. This would show how much of a text-heavy, tree-structured UI fits, and at what depth.
- Gallery in one circuit: all 222 photos with seven column variants, a Brent-Kung scan and gathers for the 1D strip, shared-matrix springs, occlusion with the rounding comparison, step-bit hit tests. Compare with the trace compiler slices (600 and 1,580 layers). This would test whether the reformulations bring a real 222-item app to tens of layers.
- Staircase text: in a real browser with real fonts, compute width thresholds per paragraph with pretext, compute heights in a circuit, and check against pretext `layout()` at 0.25px sweeps. Cover rich-inline with links, italics, code blocks, soft hyphens, `pre-wrap`, and long URLs. Then extend to line end offsets per line for painting fragments. This would show how far text layout goes with comparisons only, and where monotonicity breaks.
- Predictive keyframes as a batch: evaluate the circuit at 200 future step counts as independent evaluations, possible because matrix powers let any step count be computed directly, and emit Web Animations keyframes with the demo's deliberately janky 300ms render loop. This would show whether a pure numeric program makes the doctrine's most complex animation pattern simple.
- Scroll anchoring and occlusion as outputs: anchor chosen by a count, delta by a gather, adjusted scroll position plus changed bit, with JS doing `scrollTo` and the read-back. Test continuous resize with fractional layout, where Scrolling.md:58 describes jitter from rounding.
- Several events per frame: compare a fixed-capacity event queue in the table, running the circuit once per event, and summarizing in JS, on the event-window traces with outward-and-back movement that must cancel a click.
