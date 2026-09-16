# Which exactness each UI depends on

The runtime computes every row as `value = bias`, then `value = fround(value + fround(weight * input))` for each term in stored order. A fused GPU kernel, a framework sparse kernel, or a parallel prefix network adds the same terms differently. This prototype asks whether tonight's UIs need that strict accumulation order on every wire, or only at rounding points: boolean atoms, `round` and `floor` chains, and comparisons back to their difference. It runs seven UIs through eight executors that add terms in different ways, driven by each prototype's own host code and checked by each prototype's own independent reference.

Short answer:

- No UI needed stored term order on ordinary sums. Reversed terms, balanced pairwise sums, fused multiply-adds, and balanced sums with fusion flipped one boolean atom open loop, on the stored run's inputs, across all UIs (hn-thread, reversed order). Closed loop, where each mode drives its own state, 5 boolean atoms flipped: 1 in hn-thread under reversed order, and 4 under fused order in cards seeds 3 and 5, at 20 and at 100 cards. Each cards flip is a hit test where the pointer sat exactly on a card's right edge in the stored run. One FP32 step of drift in the card's x position (e.g. 380.50003 instead of 380.5) moved the score `256 · (pointer x - card x - 320) + 0.5` from 0.5 to 0.4921875. None of these flips changed a decision output or a reference check. The prototypes' reference checks saw one new mismatch, in 3,600 gallery frames: a settle bit that went one frame late (see [What changed a decision](#what-changed-a-decision-and-why)).
- FP32 rounding itself is required. float64 everywhere, which also stands in for a GPU compiler folding `(x + K) - K`, broke every UI that uses round chains: life-calendar (1,150,506 wrong rows, columns and days of week per field over 42 states), draggable cards (5,736 of 12,000 frames against the demo at 20 cards), text-editing (1,436 of 1,500 frames against the plain JS editor), and the progress ring (18,820 of 20,000 percent labels). Keeping stored FP32 order only at rounding points, 1.6% to 61% of rows, with float64 everywhere else, brought all four back to 0 decision flips.
- The one UI where rounding points weren't enough is the gallery. A spring's settle test compares a destination recomputed this frame with last frame's FP32 copy. At 50,607 px, recomputing in float64 differs from the copy by 0.0105 px, just above the 0.01 threshold, so springs keep animating (15 frames, 108 mismatches against index.ts, one spring 2,465 px off). That test needs the same arithmetic in both frames, not stored order.
- On the GPU, max guards only at rounding points gave 0 decision mismatches through wgpu and Dawn on codegen's five instance workloads and 12 random circuits (the gallery and the other UIs above weren't run on the GPU), with 84 guards instead of 537 for IndirectOS's press map, 25 instead of 67 for life-calendar, and 30 instead of 787 for the SDF shapes.
- The "13.9 px spike" in phase 3's note isn't a pixel. It's Photos' stack order output, which IndirectOS writes into `style.zIndex`. Window positions and sizes drift by at most 0.0022 px in every mode.

Update, September 14, 2026: the repo root builder now records rounding points. It records boolean atoms and `emitCompare`'s operations automatically, and the steps of a round chain only when the caller marks them with `circuit.markRoundingPoint` ([execution-model.md](../../../execution-model.md#rounding-points)). Existing circuits record only their boolean atoms, e.g. IndirectOS's 64.

Update, September 15, 2026: window-manager.ts and photo-gallery.ts moved to host-timed springs, so this folder imports the pre-change IndirectOS from codegen's `window-manager-copy.ts` and `photo-gallery-copy.ts`. That includes the import lines of `copies/codegen/indirect-os-machine.ts` and `copies/codegen/window-ownership.ts`, whose code is otherwise unchanged.

## What it is and how to run it

From the repository root:

- `bun test lab/ui-exploration/exactness-budget` runs 8 tests in about 1 to 2 seconds.
- `bunx tsgo -p lab/ui-exploration/exactness-budget` typechecks the folder.
- `bun lab/ui-exploration/exactness-budget/report.ts [section...]` runs the measurements and merges them into `results.json`. Sections and rough times: `indirect-os` (1 s), `trace` (1 s), `gallery` (110 s), `hn` (40 s), `cards` (175 s), `typing` (60 s), `dock` (17 s), `life` (12 s), `gallery-settle` (20 s), `random-cpu` (5 s), `cards-booleans` (20 s), `dock-tie` (5 s). Everything takes about 8 minutes.
- `deno run --unstable-webgpu --allow-all lab/ui-exploration/exactness-budget/gpu-headless.ts` runs codegen's instance workloads on the GPU through wgpu and prints one JSON line per result. The saved output is `gpu-results-wgpu.json`.
- `WORKLOADS=ui DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/exactness-budget/gpu-headless.ts`, then the same with `WORKLOADS=random`, runs them through Dawn. The `webgpu` npm package (0.6.1) can be installed in any scratch folder; this session reused the one codegen installed in the session scratch folder `phase2/codegen/dawn` (not in the repo). The saved output is `gpu-results-dawn.json`. Dawn's Node bindings still crash now and then with exit 139 (once in four UI runs during verification, between the candidate-gallery grid and the SDF shapes); rerunning the command has worked so far.

`numeric-ui-core.ts`, `window-manager.ts`, `photo-gallery.ts` and `candidate-gallery.ts` are imported from the repo root, unchanged. Code from other prototype folders is copied into `copies/` (codegen, gallery, hn-thread, lists, text-editing, numeric-library, as they were tonight), with relative paths to the repo root two levels deeper, e.g. `'../../../numeric-ui-core.ts'` became `'../../../../../numeric-ui-core.ts'`, and the gallery's fixture directory moved the same way. The codegen copies differ in three more ways: `indirect-os-machine.ts`, `window-ownership.ts` and `workloads.ts` import the repo root's `window-manager.ts` and `candidate-gallery.ts` instead of codegen's `window-manager-copy.ts` and `candidate-gallery-copy.ts`; `indirect-os-machine.ts` gains one option, `production`, so a machine can reuse a circuit whose evaluators were already replaced; and its header comment was rewritten to say it uses the production module. `gpu-headless.ts` typechecks with the folder but only runs under Deno or Node.

## What was built

| File | What it holds |
| --- | --- |
| `interpreter.ts` | codegen's flattened program packed into typed arrays, the eight modes, an exact FP32 fused multiply-add, rounding point detection, and `installInterpreter`, which replaces `createTensorEvaluator` and `evaluateTensor` on one Circuit instance |
| `measure.ts` | the stored pass and the per-mode pass, open and closed loop counts, and `traceDifference` |
| `workloads.ts` | six UI traces, each running its prototype's host code and returning that prototype's reference checks |
| `life-calendar-run.ts` | codegen's life-calendar in each mode, shared rows once per state and per-cell rows per cell |
| `wgsl-rounding.ts`, `rounding-positions.ts` | codegen's WGSL emitter with four guard placements |
| `gpu-headless.ts` | the GPU harness, with outputs split into decisions and continuous values |
| `report.ts`, `results.json`, `gpu-results-*.json` | measurements and saved outputs |
| `exactness.test.ts` | fast checks of the interpreter, the rounding points, two UIs and the emitted WGSL |

### Modes

| Mode | How each row adds its terms |
| --- | --- |
| `stored` | bias, then `fround(total + fround(weight * input))` per term, in stored order: the production executor |
| `reversed` | the same, with terms in reverse order |
| `balanced` | pairwise sums over the bias and the rounded products, like a parallel prefix network |
| `fused` | stored order, each product added without rounding it first |
| `balancedFused` | balanced sums whose first level fuses one product into each pair |
| `float64` | every value in float64, the boolean atom as `score >= 0.5`, nothing rounded |
| `roundingStrict` | `stored` at rounding points, `balancedFused` everywhere else |
| `float64RoundingStrict` | stored FP32 order at rounding points, with inputs rounded to FP32 first, and float64 everywhere else |

The fused multiply-add is exact: the double product of two FP32 values needs 48 bits, and TwoSum recovers the error of the double sum, which only matters when that sum sits exactly between two FP32 values. The tests compare it with a BigInt reference that rounds the exact sum directly to 24 significant bits. Of 20,000 random cases, more than 1,000 differ from product-then-add, but none puts the double sum on a midpoint while the exact sum is elsewhere, the only case where TwoSum's correction changes the result. So the test adds 8,000 hand-built cases that do. For example, with `a = 1 + 2^-23` and `w · x = 2^-24 · (1 - 2^-46)`, the double sum is the midpoint `1 + 3 · 2^-24`, which rounds to the even neighbor `1 + 2^-22`, while the exact sum is below the midpoint and rounds to `a`. Rounding the double sum once gets 4,204 of those 8,000 cases wrong; the fused multiply-add gets all of them right.

### Rounding points

The builder doesn't record which rows are rounding points, so the interpreter recovers them from the compiled rows and each row's builder operation. Seeds are rows where FP32 rounding turns a value into a decision:

- boolean atoms;
- round and floor chains: a `roundAffine` row with a bias between 2^22 and 2^24, e.g. `x + 2^23 + 2^22` and the row that subtracts it again;
- sign tests that aren't boolean atoms: a ReLU of one runtime value scaled by a power of two of at least 2^8, e.g. the gallery's `relu(2^40 · difference + 0.5)`.

From each seed, the walk goes back through rows with one runtime input (scales, clamp stages) and through clamp shapes, where every input is a ReLU, and stops after marking the first row that combines several runtime values: the comparison difference. For example, `emitCompare(a, b, '>=')` marks its boolean atom, its clamp ReLUs and `roundAffine([[a, 1], [b, -1]])`, while a blend like `roundAffine([[a, 0.3], [b, 0.7], [unit, 5]], 1)` stays unmarked (test: "rounding points reach back from an exact comparison").

A row is order-sensitive when reordering or fusion can change its FP32 result: three or more addends counting a nonzero bias, or two addends with a weight that isn't a power of two. A difference `a - b` isn't order-sensitive, so `roundingStrict` can only differ from `balancedFused` at order-sensitive rounding points.

### Measurement

Each UI runs once with the stored interpreter, which records every source table, checks every evaluated root against the production executor, and classifies rows: bit rows (exact bits in every stored evaluation, taking both values), decision outputs (evaluated roots that are integers in every stored evaluation, e.g. next-source bits, cursor codes, slot indices), and always-integer source cells. Then each mode replays the app with the mode driving its own state. On call k, the harness also evaluates the stored interpreter and the mode on the stored run's k-th source table, so one pass gives:

- open loop: flips of booleans, bit rows, gather indices, decision outputs and settle bits on identical inputs;
- closed loop: the same flips on the mode's own state, divergence frames (calls where some always-integer state cell differs from the stored run), and continuous drift by output group;
- the prototype's own reference check, run on the mode's frames.

Decisions compare as the FP32 values the host would store, so a float64 1234.000000001 isn't a flip. Settle bits compare the way the host reads them, e.g. IndirectOS requests another frame when `animationActive > 0`.

The six traces in `workloads.ts`:

- IndirectOS: codegen's 240-frame session at 1280×800, checked by press targets from a float64 stack walk and 11 state transitions (window 0 ends at 254, 154, Photos maximized, photo 5 focused, and so on).
- gallery: its six dyadic random traces, seeds 5000 to 5005 over six viewports, 600 frames each, where strip positions pass 170,000 px, checked against native index.ts.
- hn-thread: the 900-frame scripted session over 251 comments with 48 rank slots, checked against the hn.js-derived reference.
- lists: draggable cards with the incremental layout, seeds 1 to 20 at 20 cards and 1 to 10 at 100 cards, 600 frames each, checked against the transcribed demo.
- text-editing: the typing session from its report, capacity 256, 12 line slots, 4 keys per evaluation, 1,500 frames, checked against the plain JS editor.
- numeric-library: the dock and progress ring over 20,000 random sources, plus the 875 progress values within 3 FP32 steps of k/24 and k/100, checked against float64.

life-calendar runs separately over 42 states (7 viewports × 6 pointers) × 27,393 cells, checked against the demo's float64 formulas.

## Measured results

Counts are exact. Timings are rough, because other agents shared the machine. Bun 1.4.0, Deno 1.42.4, Node 23.10.0 with `webgpu` 0.6.1, Apple GPU through Metal.

### Rounding points per UI

| UI | Live operations | Layers | Rounding point rows | Share | Order-sensitive rows | Order-sensitive rounding points | Seeds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| IndirectOS | 5,253 | 192 | 256 | 4.9% | 840 | 0 | 64 booleans |
| gallery | 48,411 | 61 | 20,884 | 43.1% | 15,975 | 5,310 | 883 booleans, 8,232 sign tests |
| hn-thread, 251 comments | 53,703 | 69 | 16,976 | 31.6% | 31,077 | 1,516 | 3,296 booleans, 8 sign tests |
| cards, 20 | 7,727 | 84 | 1,232 | 15.9% | 1,954 | 80 | 240 booleans, 20 round chain rows |
| cards, 100 | 36,207 | 90 | 6,032 | 16.7% | 9,074 | 400 | 1,200 booleans, 20 round chain rows |
| text-editing, capacity 256 | 90,635 | 536 | 24,157 | 26.7% | 13,441 | 10,631 | 19,160 booleans, 2,560 round chain rows |
| dock and ring | 2,230 | 41 | 1,362 | 61.1% | 466 | 314 | 298 booleans, 158 round chain rows, 272 sign tests |
| life-calendar | 2,054 | 30 | 33 | 1.6% | 158 | 4 | 4 booleans, 6 round chain rows |
| 12 random circuits | 411 to 717 | | 106 to 196 | 24% to 29% | | 18 to 54 | |

IndirectOS has no order-sensitive rounding point: its comparisons are two-term differences like `x - left` and power-of-two clamp stages, whose FP32 results don't depend on order or fusion. text-editing's rounding points are order-sensitive in form, but text-editing keeps every value an integer, and no order mode changed a single one of its decisions.

### Decisions per UI and mode

"Flips" count booleans, bit rows, gather indices and decision outputs that differ from the stored interpreter, open loop on the stored source tables and closed loop on the mode's own state. Drift is the largest closed-loop difference of a continuous output.

**IndirectOS**, 240 frames, 141,120 decisions per mode. Every mode passed all 7 press targets and 11 transitions.

| Mode | Flips open / closed | Divergence frames | Window positions and sizes | Stack order output |
| --- | --- | ---: | ---: | ---: |
| reversed | 0 / 0 | 0 | 0.0021 px | 13.9 |
| balanced | 0 / 0 | 0 | 0.0022 px | 1.81 |
| fused | 0 / 0 | 0 | 0 px | 3.8e-6 |
| balancedFused | 0 / 0 | 0 | 0.0022 px | 1.81 |
| float64 | 0 / 0 | 0 | 0.0021 px | 1.17 |
| roundingStrict | 0 / 0 | 0 | 0.0022 px | 1.81 |
| float64RoundingStrict | 0 / 0 | 0 | 0.0021 px | 1.17 |

Dock outputs didn't drift at all; Photos outputs drifted by at most 0.0022 px.

**gallery**, 6 traces × 600 frames, 17,299,800 decisions per mode. The stored run matches index.ts on all 957,258 checks. No boolean atom or gather index flipped in the order modes. float64 and float64RoundingStrict flipped 44 boolean atoms closed loop, which are part of the table's 3,674, with 3,509 bit rows and 121 decision outputs.

| Mode | Flips open: bit rows / decision outputs | Flips closed | Divergence frames (traces) | index.ts mismatches | Photo springs, closed |
| --- | --- | ---: | --- | ---: | ---: |
| reversed | 19,165 / 60 | 1,307 | 1 (1) | 1 | 0.20 px |
| balanced | 18,910 / 62 | 1,307 | 1 (1) | 1 | 0.28 px |
| fused | 2,279 / 15 | 0 | 0 | 0 | 0.031 px |
| balancedFused | 19,302 / 62 | 1,307 | 1 (1) | 1 | 0.28 px |
| float64 | 20,049 / 62 | 3,674 | 15 (2) | 108 | 2,465 px |
| roundingStrict | 19,302 / 62 | 1,307 | 1 (1) | 1 | 0.28 px |
| float64RoundingStrict | 20,049 / 62 | 3,674 | 15 (2) | 108 | 2,465 px |

In every mode, the open-loop decision output flips equal the settle flips, so all of them are `stillAnimating`. Destinations drifted by at most 0.28 px in the order modes, at coordinates where one FP32 step is 1/64 px.

**hn-thread**, 251 comments, 900 frames, 10,728,000 decisions per mode. The stored run matches hn.js on 2,102,176 decisions.

| Mode | Flips open / closed | Divergence frames | hn.js mismatches (tie band) | Thread outputs, closed |
| --- | --- | ---: | --- | ---: |
| reversed | 2 / 2 | 0 | 0 (0) | 0.0059 px |
| balanced | 0 / 0 | 0 | 0 (0) | 0.0020 px |
| fused | 0 / 0 | 0 | 0 (0) | 0.0020 px |
| balancedFused | 0 / 0 | 0 | 0 (0) | 0.0020 px |
| float64 | 93 / 93 | 0 | 0 (14) | 600 px |
| roundingStrict | 0 / 0 | 0 | 0 (0) | 0.0020 px |
| float64RoundingStrict | 0 / 0 | 0 | 0 (0) | 0.0024 px |

The float64 row's 600 px is one thread output (wire 82697) reading 0 instead of 600 at frame 813; I didn't trace it.

**cards**, 20 seeds at 20 cards and 10 seeds at 100 cards, 600 frames each; 13,801,364 and 23,165,545 decisions per mode.

| Mode | 20 cards: flips open / closed | Divergence frames (traces) | Demo mismatch frames | Card positions | 100 cards: flips open / closed | Divergence frames (traces) | Demo mismatch frames | Card positions |
| --- | --- | --- | ---: | ---: | --- | --- | ---: | ---: |
| reversed | 0 / 0 | 0 | 0 | 0.00012 px | 0 / 0 | 0 | 0 | 0.00003 px |
| balanced | 0 / 0 | 0 | 0 | 0.00012 px | 0 / 0 | 0 | 0 | 0.00006 px |
| fused | 0 / 13 | 0 | 0 | 0.00024 px | 0 / 13 | 0 | 0 | 0.00098 px |
| balancedFused | 0 / 0 | 0 | 0 | 0.00012 px | 0 / 0 | 0 | 0 | 0.00006 px |
| float64 | 90,658 / 429,547 | 9,109 (20) | 5,736 of 12,000 | 1,801 px | 72,078 / 411,124 | 4,902 (10) | 3,569 of 6,000 | 9,782 px |
| roundingStrict | 0 / 0 | 0 | 0 | 0.00012 px | 0 / 0 | 0 | 0 | 0.00006 px |
| float64RoundingStrict | 0 / 0 | 0 | 0 | 0.00024 px | 0 / 0 | 0 | 0 | 0.0015 px |

The stored run itself already differs from the float64 demo's animating bit on 1 and 62 frames, lists' known settle difference; every mode except float64 kept those counts unchanged. The fused row's 13 closed-loop flips at each card count are 2 boolean atoms and 11 bit rows, in seeds 3 and 5 (item 5 in [What changed a decision](#what-changed-a-decision-and-why)).

**text-editing**, capacity 256, 1,500 frames, 2,870 keys, 47,866,500 decisions per mode. Every mode except float64 flipped nothing and matched the plain JS editor on every frame. float64 flipped 16,973,368 decisions open loop, and 1,436 of 1,500 frames disagreed with the editor. All positions are integers in quarter pixels, so there's no continuous drift.

**dock and ring**, 20,882 evaluations, 14,262,406 decisions per mode.

| Mode | Flips: bit rows / gather indices | Against float64: percent labels, boundary values, lit ticks, nearest icon | Dock icons | Ring |
| --- | --- | --- | ---: | ---: |
| reversed, balanced | 0 / 0 | 0, 0, 0, 0 | 0.00037 px | 0 px |
| fused, balancedFused | 308 / 116 | 0, 0, 0, 0 | 0.00037 px | 0.00024 px |
| float64 | 826,896 / 31,759, plus 785,957 booleans | 18,820 of 20,000, 637 of 875, 0, 0 | 0.00037 px | 134 px |
| roundingStrict, float64RoundingStrict | 0 / 0 | 0, 0, 0, 0 | 0.00037 px | 0.00024 px |

**life-calendar**, 42 states × 27,393 cells, 9,204,048 decisions per mode.

| Mode | Decision flips | Mismatches against the demo | Position drift |
| --- | --- | ---: | ---: |
| stored, reversed, balanced, fused, balancedFused, roundingStrict | 0 | 0 | 0 px (0.0002 px from float64) |
| float64 | 3,452,316: day of week, row and column 1,150,506 each, pills 756, hover 42 | 3,452,316 | 1,830 px |
| float64RoundingStrict | 0 | 0 | 0.00024 px |

**Random circuits**, codegen's 12 circuits × 256 instances, replayed on the CPU, counting outputs that are exactly 0 or 1. Reversed order flipped 768, 731 and 90 bits on circuits 1, 2 and 6, and balancedFused flipped 512, 763, 78 and 6 on circuits 1, 2, 6 and 8. roundingStrict and float64RoundingStrict flipped 0 on all 12. Outputs that are integers only because they pass 2^24, like products of products, still change under roundingStrict (27, 37, 55 and 71 on circuits 2, 3, 4 and 6); they're continuous values, which is why the GPU harness counts only exact bits as random-circuit decisions.

### What changed a decision, and why

1. **Settle tests on drifting spring state** (gallery, every order mode). Each photo spring settles when `emitAny` of four sign tests like `relu(2^40 · (|velocity| - 0.01) + 0.5)` is 0. Under another order, a spring velocity near the end of an animation comes out 0.0094 instead of 0.0103, and the settle bit flips. Every bit-row flip inspected has this shape: `report.ts gallery-settle` counts 68 flips in trace 5000's first 120 frames under roundingStrict, all in these `emitAny` combinations and none in a rounding point. The difference starts in 4- to 12-term spring and layout rows, not in a rounding point. When the last moving spring flips, `stillAnimating` flips. Closed loop, that happened once in 3,600 frames (trace 5001, frame 248), and the next frame ran 4 animation steps instead of 0.
2. **Recomputing a value stored in FP32** (gallery, float64 and float64RoundingStrict). A photo's spring also settles on its destination change, the destination recomputed this frame minus last frame's copy in the source table. With stored arithmetic both are the same bits, so the change is exactly 0. In float64, photo 123's destination recomputes to 50,606.794 while the FP32 copy holds 50,606.805, because the stored prefix sum rounds at 1/256 px per step there; 0.0105 px is above the 0.01 threshold. On trace 5001 that's 8 frames of `stillAnimating`, 17 frames of extra animation steps and 15 `visible` flips. Keeping rounding points strict doesn't help, because neither the destination nor its copy is a rounding point. In balancedFused closed loop, the mode commits its own destinations, so copies agree; open loop the stored run committed them, which is why `stillAnimating` flips on 27 open-loop frames of the same trace in both modes.
3. **Round chains without rounding** (every float64 failure). `round(x) = (x + 2^23 + 2^22) - (2^23 + 2^22)` rounds only because FP32 values are whole numbers at 2^23. In float64 the chain returns x, so life-calendar's `round(week · (1/m) - (m - 1)/(2m))` stops being a row index, and cards' step count bits become fractional and step springs a fractional number of times. Stored FP32 order at the chain's rows, with float64 everywhere else, repaired every UI with round chains.
4. **Ties inside a round chain** (dock and ring, fused modes). `emitSinCos` rounds `angle · 2/π` to a quadrant. At 3π/4 the FP32 product is exactly 1.5, a tie that rounds to 2, while the exact product is just below 1.5, so fusing it into the shift gives 1 (test: "a round chain meets a tie"). 5π/4 meets the same kind of tie at 2.5. Two rounding points whose results depend on fusion lead to these ties. Of the 116 evaluations with flips, 82 start at the quadrant shift, with the angle at 3π/4 (40) or 5π/4 (42). The other 34 start one row earlier, at the angle row `progress · 2π - π/2`: at progress 0.875 plus one FP32 step, the fused angle is 3.9269912 against 3.9269910 in stored order, and the shift then rounds to quadrant 3 instead of 2. No position moved, but 308 bits and 116 gather indices flipped. roundingStrict keeps stored order at both rows and removed those flips (`report.ts dock-tie`).
5. **A hit test at an exact tie, on drifted state** (cards, fused order, closed loop). The hit test for a card's right edge scores `256 · (pointer x - card x - 320) + 0.5` and rounds the score to a boolean atom. In seed 3 at frame 374, the pointer is at 700.5 and card 7 (card 38 at 100 cards) is at 380.5, so the score is exactly 0.5, which rounds to 1. With fused order driving its own state, the card is one FP32 step further right, at 380.50003, the score is 0.4921875, and the boolean is 0. Seed 5 has the same case at frame 172, with the pointer at 698.5 and card 18 (card 93 at 100 cards). The boolean atom is a rounding point, so roundingStrict would keep its stored order, but its input comes from spring state that drifted in rows that aren't rounding points, the same way the gallery's settle tests read drifted velocities. No decision output flipped, and the demo check matched on every frame (`report.ts cards-booleans`).

### The largest drift, traced

`report.ts trace` walks back from IndirectOS's largest closed-loop difference, reversed order, frame 164, four frames after the photo click in maximized Photos. The output is Photos' `stack` field, 18.47 against 4.61 in the stored run. IndirectOS adds `40 × animation.active` to the stack terms (window-manager.ts:1058) and writes `style.zIndex = 10 + stack` (window-manager.ts:1442). The difference has two parts:

- **This frame's arithmetic, 1.48.** Stored arithmetic on the mode's own state gives 16.99, and reversed arithmetic on the same state gives 18.47. From the output back, `animation.active` clamps a sum of per-lane activity terms, each `100 × relu(|velocity| - 0.01)`, and the velocity comes from a spring step with stiffness 650 and a 4.17 ms step. The difference starts in a 3-term sum `1256.00049 - 1256 - 0.0000893`, a spring position at 1,256 px, where one FP32 step is 1/8192 px, so the order of the three terms changes the result by one step. The open-loop trace, on the stored run's state, also ends in a 3-term sum at 1,256 px.
- **The state the mode carried into this frame, 12.38.** This is stored arithmetic on the mode's state (16.99) against the stored run (4.61). Its trace ends at a source cell, Photos' width spring velocity (cell 128), which differs by 0.0035. The factor 40 × 100 turns that velocity difference into 12.4 z-index units.

Across frames, `report.ts trace` goes one step further but doesn't take the growth apart. The whole state last matched the stored run at frame 100, when window 1 closed. On that frame, reversed order changed window 1's center and scale springs, and the largest change, window 1's center x velocity (-402.89441 against -402.89432), starts in a 3-term sum `660 - 609 - 0.5755` inside a spring step. The state has differed ever since. Photos' width velocity first differs at frame 132, two frames after Photos maximized. Sampled every 4 frames, its difference stays at 0.0017 or less until frame 156, then reaches -0.0031 at frame 160 and -0.0035 at frame 164. The report doesn't separate how much each frame's arithmetic added, or how the difference in window 1's springs reached Photos' width spring.

The frame's pixel outputs differ by at most 0.0022 px. During settling, the z-index string is fractional (for example '14.61'), and CSS `z-index` only accepts integers, so browsers ignore that assignment. Balanced order's largest difference (1.81, frame 148) is window 1's stack order. That frame's arithmetic and the open-loop trace end in the same kind of 3-term sum at 287 px (`286.99948 - 287 + 0.0000986`), and the state part ends at window 1's center y velocity (cell 107).

### WGSL with guards only at rounding points

Decision mismatches were identical through wgpu and Dawn except where noted. For the UI workloads, decisions are fixed output columns: every output of the press map (owner and region codes), every life-calendar output except x and y (filled, today, the pill bits, day of week, hovered, row, column and size), candidate-gallery's selected layout bits and hero-present bit, and the SDF owner. For random circuits, decisions are outputs that are exactly 0 or 1 on every instance. "Guards" count `max(x, lowest)` wrappers.

| Workload | Per-instance rows (rounding points) | Guards: every row / rounding points / rounding points and inputs | Decision mismatches, no guard | Decision mismatches, any guard placement | Continuous outputs that differ with rounding-point guards |
| --- | --- | --- | --- | ---: | --- |
| IndirectOS press map, 1280×800 | 458 (112) | 537 / 84 / 140 | 0 of 2,048,000 | 0 | none; every output is a decision |
| life-calendar, 27,393 cells | 63 (30) | 67 / 25 / 28 | 156,594 wgpu, 156,932 Dawn, of 438,288 | 0 | 0 |
| candidate-gallery, 256 widths | 111 (2) | 170 / 8 / 12 | 0 | 0 | 1,130 of 14,080, largest 6.1e-5 px |
| candidate-gallery, 256×256 grid | 135 (2) | 201 / 8 / 12 | 0 | 0 | 325,019 wgpu, 327,231 Dawn, of 3,604,480, largest 2.4e-4 px |
| SDF shapes, 560×360 | 756 (36) | 787 / 30 / 42 | 0 | 0 | 41,728 wgpu, 41,944 Dawn, of 1,209,600, largest 0.0033 of 255 |
| 12 random circuits, 256 instances | 5 to 621 | 6,781 / 1,739 / 2,162 | 833 wgpu, 840 Dawn, of 72,448 | 0 | largest 1.7e10 wgpu, 1.4e11 Dawn, on products of products |

"Rounding points and inputs" adds one guard around the final value of each row a rounding point reads, so the compiler can't regroup an input's own sum into the rounding point's sum. It didn't change any decision count, and it brought the SDF colors back to codegen's unguarded 0.0016.

### Correctness checks

- The stored interpreter matched the production executor on every evaluated root of every evaluation in the report: 102,960 for IndirectOS, 21,546,000 for the gallery, 6,146,100 for hn-thread, 4,868,100 and 9,646,050 for cards, 1,219,500 for text-editing, 2,819,070 for the dock and ring. The tests also compare all 1,260,720 live values of the IndirectOS session (240 frames × 5,253 operations; the source cells copied into each evaluation aren't counted).
- The WGSL for all four guard placements, interpreted with strict FP32 rounding by codegen's interpreter, reproduces generated JS on candidate-gallery's 256 widths and the first 1,024 life-calendar cells.
- Every mode runs each prototype's own independent reference check; the tables above list them.

## What this shows about how far the approach goes

### What fit well

- In six of the seven UIs (IndirectOS, hn-thread, cards, text-editing, the dock and ring, life-calendar), decisions depended on stored FP32 arithmetic only at rounding points. With stored order at rounding points, and balanced sums with fusion or float64 everywhere else, no boolean atom, bit row, gather index, decision output or reference check changed, and positions drifted by at most 0.0022 px for IndirectOS's windows, 0.006 px for hn-thread, 0.0015 px for 100 cards, 0.0004 px for the dock and 0.00024 px for life-calendar. Arithmetic away from rounding points can still reach a decision through state: under fused order everywhere, one FP32 step of drift in a card's position flipped 4 hit tests in cards, each sitting exactly on a card's edge, without changing a decision output.
- The gallery is the exception. A settle test that compares a destination recomputed this frame with last frame's stored copy needs the same arithmetic in both frames, so float64 away from rounding points gave 108 index.ts mismatches and 2,465 px of spring drift, and roundingStrict still gave 1 mismatch, where another order moved a settle frame. In the order modes, its springs drifted by at most 0.28 px at 170,000 px.
- Most rounding points were already order-independent by construction. IndirectOS has 256 rounding point rows and none can change under reordering or fusion. The rounding points whose fusion changed a decision tonight are two dock rows near ties at 3π/4 and 5π/4: `emitSinCos`'s quadrant shift and the angle row before it.
- For fused GPU kernels, guards at rounding points were enough on both GPU stacks for codegen's five instance workloads and 12 random circuits, with 2.7 to 26 times fewer guards on the UI workloads; the gallery and the other UIs weren't run on the GPU. For parallel prefix networks, balanced sums without fusion matched balancedFused on every reference check and flipped no more bits (0 instead of 308 in the dock). For a notation where statement order doesn't matter, the term order of ordinary sums never decided anything tonight except through drifted state; the constructs that produce rounding points (booleans, round chains, comparisons) are where order would stay.
- Replacing a Circuit instance's two evaluators let every prototype's host loop and reference checks run unchanged in each mode.

### What got awkward

- **Settle rules on continuous state.** A threshold like `|velocity| < 0.01` decides on whatever the executor's arithmetic produced, so another order moves the settle frame by one now and then. That's the gallery's single closed-loop divergence; lists already saw the same effect against the float64 demo. A comparison sitting exactly on its threshold is the extreme case: cards' hit tests at an exact edge flipped after one FP32 step of drift in a card's position.
- **Values compared with their own stored copy.** A settle test on a destination change needs the frame that commits the destination and the frame that recomputes it to use the same arithmetic. Recomputing in float64 against an FP32 copy left springs animating at 50,000 px.
- **Recovering rounding points from compiled rows is guesswork.** The seeds are a boolean atom, a bias between 2^22 and 2^24, or a ReLU scale of at least 2^8. life-calendar's grid sizing clamps with a scale of 128 and no boolean atom, so those rows aren't seeds; that UI kept its decisions because its thresholds have margin, not because the walk found them.
- **Classifying decisions from traces needed care.** "Always an integer" includes products past 2^24, and "always 0 or 1" included ReLU ramps resting exactly at 0 until bit rows had to take both values.
- **Continuous gains in outputs amplify drift.** IndirectOS's stack order multiplies settle speed by 4,000.
- **The CPU fused mode fuses within a row.** The GPU compilers also fuse and regroup across rows; the GPU decision counts agreed with the CPU anyway.
- **Dawn's Node bindings crashed** (exit 139) when the harness ran the reference evaluator per instance between GPU calls. Precomputing those checks and running UI workloads and random circuits in separate processes made the crashes rare but didn't remove them: one of four UI runs during verification still exited 139 after the candidate-gallery grid, and a rerun passed.

### What stayed outside the circuit

Nothing moved in or out: the modes only change how the executor adds terms. The source table stays a Float32Array in every mode, and that storage boundary is where float64 recomputation and FP32 copies disagree. Style strings stay in JS, including IndirectOS's fractional z-index.

## How it connects to the talk

The talk says we compress concepts too early. "Every wire is bit-exact FP32" compresses two different requirements into one: decisions that must be exact bits, and geometry that must stay within a known distance. Going one level down, to how each row adds its terms, separates them. Decisions depend on a small, recognizable kind of row, which is 1.6% to 61% of rows depending on the UI, and in six of the seven UIs the rest is geometry that tolerated any addition order within measured distances. The level below also showed a third requirement the single rule had hidden: a value compared with its own stored copy, like the gallery's destination, needs consistent arithmetic. And a comparison is only as exact as the state it reads, so a threshold that the state sits exactly on, like a card edge under the pointer, can still flip when geometry drifts by one FP32 step.

On homogeneity: most of a program can be one uniform instruction, "add these terms in whatever order and precision the hardware prefers", directed by one flag per row saying whether the row is strict. The builder's own constructs, e.g. `boolean`, `round` and the comparison macros, already imply those flags.

## Open questions and next steps

- Let the builder mark rounding points when it emits booleans, round chains and comparisons, instead of recovering them from compiled rows. The WGSL emitter and a notation could use the marks directly.
- Give settle tests a rounding point of their own, for example comparing a destination change quantized to 1/64 px, so recomputation in another precision can't keep a spring animating. Hit tests on spring positions could quantize the position the same way, so one FP32 step of drift can't move a comparison off a tie.
- An integer representation, e.g. `i32` in WGSL, for round-chain values would remove the guards there.
- Check guard placement on Vulkan, D3D12 and Safari's WebGPU, and add a CPU model of fusion across rows.
- Run the modes on spring-bank's IndirectOS copy, indirect-os-2 and instanced-items once those land.
- Derive strictness from an error budget per output, e.g. positions within 0.05 px and z-index exact, instead of from construction patterns.
- IndirectOS's projection writes a fractional z-index while settling; keeping the animation term out of `stack`, or rounding it, would make that output an integer. Update, September 15, 2026: done in window-manager.ts, where each window's activity is now an exact bit.
