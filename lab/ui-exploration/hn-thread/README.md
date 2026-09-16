# HN thread as one circuit

## What it is and how to run it

This prototype rebuilds the render path of Cheng's nicer-hacker-news thread (nicer-hacker-news's `hn.js`, with the pretext-based comment heights of the vibescript port in vibescript's `demos/nicer-hacker-news`) as one Indirect circuit. JS writes the window size, the scroller's `scrollTop`, the pointer position, the pointer-down bit and a click latch into a Float32Array source table, runs the circuit once per frame, copies the next-state outputs back into the table, and turns the other outputs into styles. The question it answers: how much of a text-heavy UI with a comment tree fits in one circuit, when comment heights come from prepared width breakpoints and the tree never changes at runtime.

Commands, from the repo root:

- `bun test lab/ui-exploration/hn-thread`: differential tests against the JS reference, about 3 seconds.
- `bunx tsgo -p lab/ui-exploration/hn-thread`: typecheck.
- `bun lab/ui-exploration/hn-thread/report.ts`: every measurement below, written to `results.json`. One section at a time: `report.ts scale`, `variants`, `breakpoints`, `differential`, `slots`, `codegen`. A one-section run replaces only that section's entries in `results.json`. The codegen section takes about 2 minutes.
- `bun lab/ui-exploration/hn-thread/mutation.ts`: corrupts live operations one at a time and checks that the tests notice.
- `bun lab/ui-exploration/hn-thread/demo.html`: the browser demo. It was checked in Chrome after this README was first written (see "Browser check" at the end).

| File | What it holds |
| --- | --- |
| `hn-data.ts` | Thread 0 of the vibescript demo data: 251 comments, indents 0..10 |
| `comment-doc.ts` | HN comment HTML to paragraphs of text, italic and link runs, and code blocks, without a DOM |
| `pretext/` | An unmodified snapshot of pretext's `src/` (commit 477510e of the read-only clone) |
| `fake-canvas.ts` | Deterministic glyph widths for running pretext under bun |
| `text-heights.ts` | A comment's height from pretext, and its tabulation into width breakpoints |
| `thread-model.ts` | hn.js layout constants and the static tree tables |
| `thread-prepare.ts` | The prepare step: parsing, pretext's prepare, breakpoints, tree tables |
| `thread-frame.ts` | The JS reference frame, derived from hn.js, and the frame types |
| `thread-circuit.ts` | The circuit builder, source table layout, machine, and program statistics |
| `differential.ts` | Random states, targeted input sweeps, a scripted session, and the tie-aware comparison |
| `codegen.ts` | Plain JS generated from the compiled program |
| `report.ts`, `mutation.ts` | Measurements |
| `demo.html`, `demo.ts`, `demo.css` | The browser projection |

## What was built

### The frame

The source table has 11 global cells (window width and height, scroll read, pointer x and y, pointer down, click latch, previous smoothed scroll, previous scroll delta, peek-up amount, previous container width) and 4 cells per comment (collapsed bit, rest height, animated height, previous natural height). That is 1,015 cells for 251 comments.

The circuit follows hn.js's `render` in order: scroll smoothing (hn.js 243-260), comment heights, submission header sizing (266-309), the hit test (314-343), shrink flags for the gutter peek (345-355), peek-up easing (357-376), height easing (377-392), row tops, sticky user banners, comment boxes and gutter lines (434-498), DOM slots, the cursor (540-560), and the keep-rendering bit.

### How each loop became arithmetic

| hn.js construct | Circuit form | Cost at 251 comments |
| --- | --- | --- |
| Comment heights read from the DOM once (hn.js 213), laid out again by pretext on resize in the vibescript port | The prepare step finds every container width in 375..1200 where a comment's height changes. The circuit adds `delta * [windowWidth >= breakpoint]` per breakpoint. Comparing the raw window width works because every breakpoint lies strictly inside the clamp range | 1,768 breakpoints, 5,283 live operations, 4 layers |
| `rowTop += height` (hn.js 434-497) | One wide sum per row, terms in row order, which performs the same rounding steps as a sequential `Math.fround` loop. Natural heights are integers, so they use a Brent-Kung scan instead | Animated tops: 506 operations, 32,637 weights, 1 layer. Natural tops: 487 operations, 974 weights, 13 more layers |
| The first row containing the pointer, with `break` (hn.js 328-341) | The pointed row is the count of row bottoms at or above the pointer. The row one-hot is the difference of neighboring comparison bits | 252 comparisons |
| The ancestor `while` loop over indents (hn.js 333) | A static table `ancestorAtLevel[row][indentPointed]`, read through the row one-hot and the indent-level one-hot | 2,761 table entries; the 11 level products lower to one gather read |
| The gutter bottom loop over following deeper rows (hn.js 480) | The top of the first row after the subtree, from a static `subtreeEnds` table | Wiring, no operations |
| Summing shrinking rows and rows before the ancestor (hn.js 363-366) | Differences of prefix sums at the pointed row and at the ancestor, as gather reads | 5 gather reads |
| The sticky user banner, `clamp(rowTop, 0, rowBottom - userHeight)` (hn.js 440) | `max(rowTop, min(0, rowBottom - userHeight))`, two relus | |
| Collapse (an extension): a comment is hidden when any ancestor is collapsed | An affine count over the static ancestor list, then one relu | 753 operations with the natural heights |
| Attaching the visible rows every frame (hn.js 441-469) | Visibility bits, then rank slots or window slots (below) | 25,616 operations for 48 rank slots |

Integer decisions such as `indentPointed <= indent[row]`, `ancestor < row` and slot keys use differences of relus, e.g. `[v >= 0] = relu(v + 1) - relu(v)`, and `[v == s] = relu(v - s + 1) - 2 * relu(v - s) + relu(v - s - 1)` for the one-hot members; both are exact for integers. Continuous decisions use the rounding boolean on a difference scaled by a power of two, chosen from a magnitude bound so the clamp's plateau stays exact: 1/128 px resolution for positions up to 65,536 px, and 1/1024 px for the window width against a breakpoint. A breakpoint found by bisection sits within 1e-6 px above the real change, so its threshold is moved down by 1/2048 px, and a width exactly on a change gets the wider side's height, as pretext gives it.

### Extensions to hn.js

These are in both the circuit and the reference, and each one is explained at the top of `thread-frame.ts`:

- Collapse. Clicking a comment's sticky banner outside the gutter toggles `collapsed`. A collapsed comment keeps a 28px banner; its descendants get height 0. The toggle lands in the next frame's state, so the hit test this frame uses committed state.
- A second eased height per row. hn.js keeps the rows below the pointer in place during a peek by adding every row's `natural - height` to the top gap. With collapse in the mix that would move the rows above a collapsing comment, so the gap is `restHeight - height`, where `restHeight` eases toward the collapse-aware natural height and ignores the peek.
- Resize. When the container width changes, both heights shift by the row's change in natural height: settled rows snap, and a running animation keeps its remaining distance. The vibescript port snaps settled rows only.
- The keep-rendering bit checks the sum of all rows' remaining distances instead of each row, so it can render a few frames longer than hn.js.
- DOM slots. hn.js appends every row in view. Here the circuit routes rows into a fixed number of slot outputs, and JS attaches a cached node per row, created the first time the row gets a slot. Rank slots give slot numbers, in row order, to rows in view that are at least 0.25px tall. Window slots give slot s to the row at `first visible row + s`, which only works because rows are sorted by their top.

### The reference and the checks

`thread-frame.ts` keeps hn.js's control flow: the row search loop with `break`, the ancestor `while` loop, the gutter bottom loop over following rows, float64 arithmetic, and heights from pretext itself instead of the prepared breakpoints. `differential.ts` compares it with the circuit:

- Decisions must match exactly, unless the reference's own values put the decision within 0.02 px of its threshold. Those count as ties, reported separately. Decisions that both sides compute exactly, like an unchanged width or a zero scroll delta, never count as ties.
- Positions must agree within 0.05 px, or 0.5 px in the scripted session, where the circuit and the reference each run on their own state for 900 frames.
- Inputs: random states (collapsed comments, heights mid-animation or at 0, scroll smoothing in progress, a stale container width) with random inputs, a third of them aimed at a random comment's banner or gutter; a sweep that clicks every comment's banner once while the comment is expanded and once while it's collapsed, and presses one of its gutter columns (the sweep counts targets it didn't hit, and there were none); a 3-comment thread, where every comment fits and the submission header grows; and a scripted session that scrolls, holds a level-1 gutter on a deep comment, collapses and expands a comment through its banner, resizes from 1024px to about 500px, and scrolls past the end.
- `mutation.ts` corrupts one live operation at a time in each build section and reruns the same checks.

## Measured results

Counts are exact and deterministic. Times are rough: a dozen other agents shared the machine.

### Scale, 48 rank slots

| Comments | Max indent | Source cells | Breakpoints | Live operations | Layers | Widest layer | Stored weights | Gather reads | Gather table entries | Comparisons |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 7 | 131 | 232 | 7,362 | 59 | 750 | 23,222 | 439 | 13,148 | 493 |
| 60 | 8 | 251 | 497 | 13,981 | 61 | 1,467 | 47,267 | 439 | 26,289 | 999 |
| 125 | 10 | 511 | 1,297 | 28,591 | 65 | 2,764 | 103,251 | 439 | 54,761 | 2,321 |
| 251 | 10 | 1,015 | 1,768 | 53,703 | 69 | 5,050 | 218,170 | 439 | 109,949 | 3,800 |

The same thread with window slots, and with no slots at all (per-row outputs only):

| Comments | Window slots: live operations | Layers | Stored weights | No slots: live operations | Stored weights |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 4,273 | 59 | 8,905 | 3,872 | 7,362 |
| 60 | 8,161 | 60 | 18,490 | 7,522 | 15,389 |
| 125 | 16,466 | 64 | 43,144 | 15,700 | 36,669 |
| 251 | 29,356 | 68 | 97,331 | 28,340 | 84,308 |

Operations grow linearly, about 113 per comment without slots and about 214 with 48 rank slots. Layers grow with the logarithm of the row count through the Brent-Kung scans. Stored weights grow faster than linearly, because the animated row tops are a triangular matrix (n²/2 weights) and rank slots store about 11 weights per comment per slot: 3 for the one-hot member, 2 for its ramp, and 3 each where the member is summed into the slot's `present` and `row` outputs.

### Where the operations and weights go, 251 comments

| Build section | Live operations | Stored weights | Deepest layer |
| --- | ---: | ---: | ---: |
| comment heights from breakpoints | 5,283 | 8,084 | 4 |
| collapse and natural heights | 753 | 2,094 | 6 |
| natural prefix sums (Brent-Kung) | 487 | 974 | 19 |
| scroll smoothing | 13 | 19 | 9 |
| vertical sizing | 32 | 55 | 26 |
| hit test | 1,364 | 4,941 | 33 |
| gutter peek | 780 | 2,043 | 50 |
| collapse toggle | 763 | 2,026 | 45 |
| height easing | 4,285 | 9,062 | 53 |
| visual prefix sums (one wide sum per row) | 506 | 32,637 | 49 |
| visual rows and gutters | 13,805 | 21,837 | 65 |
| DOM slots (48 rank slots) | 25,616 | 134,366 | 69 |
| cursor | 12 | 28 | 54 |

The depth is one long chain: natural heights, their Brent-Kung scan, the hit test, the ancestor reads, the ancestor's final height, easing, animated row tops, about 15 layers of clamps, comparisons and selects for each row's banner and gutter, the occupancy scan, and the slot reads.

### Variants, 251 comments

Each variant also ran 150 random single frames against the reference: 0 decision mismatches, 0 tie frames and 0 position mismatches in every row.

| Variant | Live operations | Layers | Stored weights | Slot section operations | Largest position drift (px) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default: 48 rank slots, Brent-Kung natural tops, one wide sum per animated top | 53,703 | 69 | 218,170 | 25,616 | 0.0156 |
| Natural tops as wide sums | 53,467 | 57 | 248,822 | 25,616 | 0.0156 |
| Animated tops as a Brent-Kung scan | 53,939 | 79 | 187,518 | 25,616 | 0.0063 |
| No slots (per-row outputs only) | 28,340 | 68 | 84,308 | 253 | 0.0156 |
| 16 rank slots | 37,287 | 69 | 129,914 | 9,200 | 0.0156 |
| 32 rank slots | 45,495 | 69 | 174,042 | 17,408 | 0.0156 |
| 96 rank slots | 78,327 | 69 | 350,554 | 50,240 | 0.0156 |
| 48 window slots | 29,356 | 68 | 97,331 | 1,269 | 0.0156 |
| 96 window slots | 29,884 | 68 | 109,379 | 1,797 | 0.0156 |
| 48 window slots, natural tops as wide sums | 29,120 | 56 | 127,983 | 1,269 | 0.0156 |

Drift is measured against the float64 reference, so the wide sums, which match a sequential FP32 loop bit for bit, still drift from float64. The balanced Brent-Kung scan drifts less, as phase 1 found.

### Slots needed, 251 comments, window heights 700..1400px

| States | Rank slots: median / 99th percentile / max | Window slots: median / 99th percentile / max |
| --- | --- | --- |
| 3,000 random states, 10% of rows mid-animation at 0px | 8 / 20 / 27 | 8 / 28 / 42 |
| 3,000 settled states, 8% of comments collapsed | 8 / 17 / 19 | 8 / 27 / 51 |
| Collapsing comment 0 (25 descendants) while it's in view, 90 frames | max 32 during the animation, 7 settled | max 32, and still 32 settled |

Window slots are 20 times cheaper, but zero-height rows in view take window slots: once a collapsed subtree has settled in view, window slots still need 32 slots where rank slots need 7.

### Breakpoints

pretext's heights for all 251 comments, sampled at every 1/4px of container width from 375 to 1200 (828,551 samples), matched the tabulated staircases at every sample. No comment got taller as the width grew. The sweep saw 1,755 height changes; tabulation found 1,768 breakpoints, because a few change twice within one quarter pixel. The largest comment has 205 breakpoints. Parsing and pretext's prepare took about 15ms, and tabulation, sampling every 4px and bisecting each change to 1e-6px, took about 150ms.

### Differential checks

| Comments | Kind | Frames | Decisions compared | Decision mismatches | Tie mismatches | Position mismatches | Largest drift (px) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | random single frames (1,727 took the branch where every comment fits) | 2,000 | 87,908 | 0 | 6 | 0 | 0.00005 |
| 60 | random single frames, 16 rank slots | 4,000 | 2,337,833 | 0 | 22 | 0 | 0.0023 |
| 60 | every comment: banner click while expanded, banner click while collapsed, gutter press | 180 | 105,951 | 0 | 0 | 0 | 0.0016 |
| 60 | scripted session | 900 | 523,699 | 0 | 0 | 0 | 0.0005 |
| 60 | random single frames, 16 window slots | 2,000 | 1,172,842 | 0 | 0 | 0 | 0.0018 |
| 251 | random single frames, 48 rank slots | 1,500 | 3,507,388 | 0 | 0 | 0 | 0.0146 |
| 251 | every comment: banner click while expanded, banner click while collapsed, gutter press | 753 | 1,764,278 | 0 | 0 | 0 | 0.0260 |
| 251 | scripted session | 900 | 2,102,176 | 0 | 0 | 0 | 0.0025 |
| 251 | random single frames, 48 window slots | 600 | 1,403,887 | 0 | 0 | 0 | 0.0133 |

Every tie mismatch was a decision whose float64 distance to its threshold was at most 5.7e-14px in the 3-comment run (5 of the 6 were exactly 0) and at most 2.3e-13px in the 60-comment run, which FP32 rounding resolved the other way. They were the visibility and gutter visibility of rows sitting exactly on the scroller's top or bottom edge, one cursor code, and 17 slot assignments that shift after one of those rows' occupancy bits flips.

In total: 12,833 frames and about 13.0 million compared decisions. The branch counts in `results.json` show how often each path ran, e.g. 573 frames with a collapse toggle (511 collapsing a comment, 62 expanding one) and 389 frames with shrinking rows in the 60-comment random run, and both toggle directions for every comment in the sweeps.

Getting the tie rule right took three tries, and each wrong version hid real coverage. A decision is a tie when the reference's own values put it within 0.02px of its threshold. The exception is a decision both implementations compute exactly, where landing exactly on the threshold is not a tie: an unchanged container width, the integer "all comments fit" check, and a scroll or peek delta that is exactly 0. The first version treated an unchanged width as a tie, and the second treated a zero scroll delta as 0.01px from the smoothing threshold. Both silently exempted every decision in most frames, which `mutation.ts` exposed.

### Mutation check

`mutation.ts` picks 6 live operations spread through each build section of the 60-comment circuit (16 rank slots), corrupts one at a time (the first coefficient `c` becomes `-c - 1`, or a relu's output is scaled by 6), and reruns 300 random single frames plus the every-comment sweep.

| Build section | Caught | What the missed ones were |
| --- | ---: | --- |
| comment heights from breakpoints | 6/6 | |
| collapse and natural heights | 6/6 | |
| natural prefix sums | 6/6 | |
| scroll smoothing | 5/6 | a relu inside `abs(scrollDelta)`, absorbed by the `min(abs(delta), 1)` clamp for these inputs |
| vertical sizing | 2/6 | 4 operations of the branch where every comment fits, which 60 comments never take; the 3-comment thread caught 6 of 6 there |
| hit test | 6/6 | |
| gutter peek | 6/6 | |
| collapse toggle | 6/6 | |
| height easing | 4/6 | relus of the keep-rendering sum, absorbed by its clamp |
| visual prefix sums | 6/6 | |
| visual rows and gutters | 6/6 | |
| DOM slots | 6/6 | |
| cursor | 4/6 | the ancestor-top read, whose corrupted term reads a constant 0 (equivalent, checked directly), and a relu absorbed by a clamp |

In total 69 of 78. An earlier version of the sweep clicked each banner from one random starting state, so for about half the comments it never clicked the banner of an already collapsed comment, and it missed a corrupted "already collapsed and clicked" bit of comment 9. The sweep now clicks every banner from both states, which catches that corruption.

### CPU time per frame

Ranges cover the two full report runs.

| Comments | Executor µs | Plain JS reference µs | Build ms | Compile ms |
| ---: | ---: | ---: | ---: | ---: |
| 30 | 53-55 | 2.0-2.1 | 31-33 | 14-15 |
| 60 | 108-110 | 3.9-4.1 | 39-41 | 20 |
| 125 | 220-226 | 7.6-8.1 | 85-104 | 35-44 |
| 251 | 440-481 | 14.3-14.5 | 159-216 | 68-118 |

The executor costs about 8 to 9ns per live operation here. The reference is hn.js's logic with cached pretext heights.

Generated plain JS (`codegen.ts`), split into functions of at most 100 or at most 300 statements, timed after a number of frames. Each configuration runs in its own process, and each time is the median of 3 batches of 20 frames. Ranges cover two runs of `report.ts codegen`. All times are in µs:

| Comments | Statements per function, at most | Functions | Statements | After 10 frames | After 100 | After 1,000 | After 3,000 | After 6,000 | After 10,000 | Executor |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 30 | 100 | 426 | 47,592 | 2,416-2,757 | 2,498-2,823 | 51-56 | 51-52 | 49-51 | 52-54 | 51-54 |
| 30 | 300 | 152 | 47,318 | 2,338-2,394 | 2,349-2,512 | 48 | 46-48 | 46 | 45-46 | 51-54 |
| 251 | 100 | 3,110 | 397,475 | 23,971-24,019 | 34,733-35,037 | 12,373-12,711 | 1,111-1,123 | 1,015-1,068 | 967-975 | 437-440 |
| 251 | 300 | 1,136 | 395,501 | 23,040-23,228 | 34,064-34,165 | 17,755-17,861 | 911-963 | 824-1,076 | 869-924 | 437-440 |

All live wires matched the executor bit for bit. Both splits were optimized by about 3,000 frames. After that, generated JS is about as fast as the executor at 30 comments and about twice as slow at 251 comments, with the 300-statement split slightly faster. In one earlier run, all four configurations shared one process on a busier machine. There, the 300-statement functions at 251 comments ran right after the 100-statement ones and still took about 20ms after 10,000 frames. That's why the report now gives each configuration its own process.

## What this shows about how far the approach goes

### What fit well

- Text heights as comparisons. With pretext's prepare step outside, all 251 comment heights at any window width are 1,768 comparisons against constants, 4 layers deep, exact at every quarter pixel sampled. Resizing needs no JS text layout. This matches what phase 1 predicted for pretext's `layout()`, at real content scale.
- Static tree walks became tables and wiring. The ancestor `while` loop is a 2,761-entry table read through two one-hots, the gutter bottom loop is a direct wire to `top[subtreeEnd]`, and "hidden because an ancestor is collapsed" is an affine count over a static ancestor list. No runtime search remains.
- Sorted rows turned searches into counts. The pointed row is a count of row bottoms above the pointer, and the one-hot of the pointed row is the difference of neighboring bits. At 251 comments the one-hot is ready 3 layers after the pointer's position in content coordinates (layer 30 against 27). That position waits for the submission header's height (layer 26), which depends on the total content height, so the one-hot is ready 11 layers after the natural prefix sums finish (layer 19).
- One wide sum per row made row tops depth 1 and bit-identical to a sequential FP32 loop.
- hn.js's frame maps onto one evaluation: latches in, next state out, and the keep-rendering bit decides whether JS schedules another frame. The per-frame easing, scroll smoothing, sticky banners, piecewise header sizing, peek-up clamp and cursor code all became a handful of relus each.
- Exact decisions held: across 12,833 compared frames and about 13.0 million compared decisions, the circuit never disagreed with hn.js's logic outside a 0.02px tie band, and positions stayed within 0.026px of float64.

### What got awkward

- Bounded visibility compaction costs as much as the rest of the UI. 48 rank slots are 25,616 operations and 134,366 weights at 251 comments, against 28,340 operations for everything else. The cost is comments × slots: every comment needs a ramp and a one-hot member per slot. Window slots use the sorted rows instead and cost 1,269 operations, but a settled collapsed subtree in view uses up slots. The missing instruction is the one phase 1 named: reading, or here scattering, at a computed integer index. With it, rank slots would cost comments + slots.
- Depth follows the UI's own dependency chain, not the approach's parallelism: 69 layers at 251 comments. Natural tops as wide sums cut it to 57 at a cost of 31,000 more weights.
- The CPU executor takes 440 to 480µs per frame at 251 comments, against about 14µs for the plain JS reference. Generated plain JS, which ran IndirectOS 12 times faster than the executor in phase 1, is slower here until JavaScriptCore has optimized its functions (1,136 or 3,110 of them at 251 comments, depending on the split), which takes about 3,000 frames. After that it is about as fast as the executor at 30 comments and still about twice as slow at 251 comments. This program is dominated by wide rows (the triangular row-top sums and the gather index computations), which the executor's sparse loop already handles well; IndirectOS averages 1.43 weights per row.
- Comparisons need magnitude bounds that the builder doesn't pick. Each comparison's scale here comes from a hand-chosen bound (65,536px for positions, 8192px for widths, 1px after clamping small differences), and the breakpoint thresholds need the 1/2048px shift. Without a bound, a comparison either loses resolution or loses its exact plateau.
- Making collapse and peek both anchor correctly needed a second eased height per row. hn.js's single height and gap formula would have moved the rows above a collapsing comment.
- hn.js lets a peeked ancestor's target height go negative when the ancestor is scrolled far above. Row tops are then not sorted for a few frames. Rank slots don't depend on the order; window slots assume the visible rows form one run, which I didn't measure in that state.
- Checking the circuit took a lot of harness work: margins for every continuous decision, targeted sweeps to reach per-row paths, and a mutation check. `mutation.ts` found coverage gaps that random inputs never reached, like the branch where every comment fits, which only a short thread takes, and clicking the banner of an already collapsed comment, which the sweep now does for every comment.

### What stayed outside the circuit

- HTML parsing, pretext's prepare, and breakpoint tabulation: about 150ms once per thread, in JS.
- The comment text itself: `innerHTML`, links (`<base target="_blank">`), native text selection, the `[+N]`/`[–]` label when the collapsed bit changes, and the cursor name from the cursor code.
- DOM node lifetime: which cached node goes with which slot, attaching and detaching.
- Canvas drawing of gutter lines, from the circuit's per-row gutter top, bottom, visible and emphasis outputs.
- Search and search highlights, selection rectangles, `elementFromPoint` for links, and the copy handler. None of these were ported.
- The browser's own text layout. The demo tabulates breakpoints with the browser's real canvas, but the comments render natively from `innerHTML`, so a comment can be a line taller or shorter than pretext predicted. On systems with non-overlay scrollbars the scroller's scrollbar also narrows the comment area by its width.

## Open questions and next steps

- A gather-at-index instruction for compaction. Rank slots are the single largest cost; an executor instruction that turns an integer into a table position without a one-hot of one member per comment would make slot routing linear.
- Frame-rate independent heights. The circuit keeps hn.js's `height += (target - height) / 5` per frame. Phase 1's matrix-power springs with fixed 4ms steps would add about 81 operations per animated value, roughly 40,000 operations for two heights per comment at 251 comments.
- Is native `innerHTML` layout close enough to pretext's prediction in real browsers, or should the demo render pretext's line fragments like the vibescript port does? The browser check at the end found 249 of 251 comments matching at one window size in Chrome.
- Search highlights and selection rectangles could come from per-line staircases (each line's end offset as a function of width), which phase 1 estimated to be much larger than heights alone.
- Codegen that handles wide rows as loops over constant arrays, instead of one statement per weight, might finally beat the executor for this kind of program.
- A thread that changes at runtime (new comments arriving) needs capacity in the tables and slots, and runtime ancestor data instead of constant tables.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/hn-thread/demo.html`.

- The page loads with no console errors. The stats show 251 comments, 55,821 live operations, 69 layers, 220,877 stored weights and 3,858 comparisons (3,800 in the scale table above, with the fake canvas), with setup at 3,426 ms and breakpoints at 656 ms.
- Scrolling the thread works, and the sticky banners stay pinned. Clicking the banner of "wyclif" collapses the comment to "[+2]", and the rows below move up. Hovering a gutter column shows the row-resize cursor. Holding a press there emphasizes the ancestor's banner and pushes the rows down, and releasing it restores the layout. No errors appeared, 8 to 13 of the 48 slots were in use, and the step time was between 750 and 5,150 µs.
- Native text layout against the prepared heights, the open question above: for all 251 comments, I compared the DOM's own height (with `height: auto`) with the circuit's comment box height. In the first check, 141 comments differed by exactly 12 px, the `commentBottomGapNatural` space inside the box, so their text heights matched. 109 differed by 20 px, i.e. the DOM was 8 px shorter than predicted, and 108 of those start with text followed by `<p>` or `<pre>` blocks. `demo.css` had `.comment > :first-child { margin-top: 0 }`, and `:first-child` skips the leading text node, so the rule removed the first block's 8 px margin, while `comment-doc.ts` counts an 8 px gap between the first two paragraphs. The DOM was never taller than the prediction, so no text got clipped, but about 108 comments had 8 px of extra space under them.
- Fixed in `demo.ts` and `demo.css`: `markLeadingBlock` gives the class `leading-block` to a comment's first `<p>` or `<pre>` only when no visible text comes before that element, and only an element with that class loses its top margin. 1 of the 251 comments starts with a block. `bun test lab/ui-exploration/hn-thread` (9 tests) and `bunx tsgo -p lab/ui-exploration/hn-thread` pass.
- Recheck in Chrome, in a 2,320 by 1,268 px iframe of the page (the tab's own viewport was 406 by 422 px this time, and the first check ran at 2,320 by 1,268 px). The stats showed the same counts as above. A script scrolled through the whole thread and measured every comment: 249 of 251 comments now differ by exactly 12 px. The other two:
  - "The species over the individual…" is predicted 14 px taller than the DOM draws, one line.
  - The comment whose HTML starts with `<p></p><pre>` is predicted 8 px taller. Its text right after `</pre>` isn't inside a `<p>`, and `comment-doc.ts` makes that text its own paragraph with an 8 px gap before it, while the DOM puts no margin there. In the other direction, the empty `<p>` lets the `<pre>` keep its 8 px margin in the DOM, where `comment-doc.ts` counts no gap before the first block. So the gaps add up to the same total, the 8 px must come from some block's text height, and I didn't track down which block.
- Demo directory check, 2026-09-14: clicking the "wyclif" banner changed it to "[+2]", but that render moved no rows, and the circuit's `scheduleNextRender` output was off after that render, so the collapsed comment stayed drawn until the next input event. A scripted `pointermove` then ran 31 frames of the collapse. Not changed, since `scheduleNextRender` is a circuit output ([notes/browser-check.md](https://github.com/chenglou/indirect/blob/exploration-2026-09/lab/ui-exploration/notes/browser-check.md#demo-directory-check-2026-09-14)).
