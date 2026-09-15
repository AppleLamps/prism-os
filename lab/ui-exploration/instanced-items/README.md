# Instanced items: per-item programs with reductions between stages

This prototype asks whether UI can be written the way a shader is written: one program per item, run over every item, with a small set of reductions across items between those programs. If so, the program's size follows the per-item program instead of the item count times that program, while decisions stay exact bits.

It adds a small builder on top of `Circuit` for staged programs, three executors for the same program (the duplicated circuit, generated JS with one instance loop per stage, and WGSL compute shaders for the per-item stages), and applies them to chenglou.github.io's photo gallery at 221, 1,000 and 10,000 photos and to IndirectOS's windows, dock items and photos. `numeric-ui-core.ts` is unchanged; every file imports it.

## What it is and how to run it

From the repository root:

- `bun test lab/ui-exploration/instanced-items` runs 14 tests in about 2 seconds.
- `bunx tsgo -p lab/ui-exploration/instanced-items` typechecks the folder.
- `bun lab/ui-exploration/instanced-items/report.ts [sizes] [traces] [orders] [scaling] [precision] [indirect-os] [rebuild]` runs the measurements below and merges them into `results.json`. Without arguments every section runs, which takes a long while (the traces and precision sections each run for several minutes) and needs about 2 to 3 GB of heap for the 10,000-photo duplicated circuit. Run one report process at a time: each process rewrites `results.json` from what it read when it started.
- `deno run --unstable-webgpu --allow-all lab/ui-exploration/instanced-items/gpu-headless.ts` runs the gallery with its per-photo stages on the GPU through wgpu and compares every stored value with the CPU executor every frame. `DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/instanced-items/gpu-headless.ts` does the same through Dawn; the `webgpu` npm package (0.6.1 here) can be installed in any scratch folder. Environment variables choose the photo counts (`GALLERY_COUNTS=221,1000,10000`), the frame count (`GALLERY_FRAMES=60`), the guard (`GALLERY_GUARD=max`), and a JSON file written after each count (`GALLERY_OUTPUT`). Saved outputs: `gpu-results-dawn.json`, `gpu-results-wgpu.json`, and `gpu-results-wgpu-every-map-stage.json` for an earlier configuration described below.
- `bun lab/ui-exploration/instanced-items/demo.html` serves the gallery at 10,000 synthetic photos driven by the staged program. `?count=221` uses the real photo list, and any other count synthetic photos. I checked that the page bundles, but I didn't open it in a browser. `demo-model.test.ts` runs its logic headlessly at 4,000 photos: it projects only visible photos, scrolling to 150,000 px shows photos past index 2,000 (rows past 400 at 5 columns), and a click opens the photo.

## What was built

### The builder (`staged.ts`)

A `StagedProgram` holds shared cells, instance arrays, and an ordered list of steps. Each step is a stage or a reduction.

- `program.sharedCell(name, minimum, maximum)` declares a uniform, e.g. the window width.
- `program.array(name, count)` declares an array of structs: `array.cell(name, minimum, maximum)` is a per-item source cell the host writes, e.g. a spring's velocity, and `array.constant(name, values)` is a per-item constant known when building, e.g. a photo's aspect ratio or its row for 3 columns.
- `program.shared(name, inputs, build)` and `program.map(array, name, inputs, build)` build one ordinary `Circuit` whose source cells are the imported values. A map stage imports shared values and fields of its own array, and its outputs become new fields of that array. The build function is plain builder code over wires, written once.
- Reductions sit between stages: `sum` and `countBits`, `prefixSum` (sequential or Brent-Kung), `firstActive`, `argmax`, `max`, `gatherAt` (a field read at a shared index), `gatherIndexed` (another array's field read at a per-item constant index), `scatter` (a shared index back into per-item bits or values), and `groupMax` (the maximum over consecutive items that share a group, into another array).
- `program.next(cell, value)` writes a value back into a cell after an evaluation, and `program.output(struct)` marks values the host reads.

For example, the gallery's click test is one map stage and one reduction:

```ts
const hit = program.map(photos, 'click hit test', {
  localX: pointer.localX, localY: pointer.localY,
  x: state.x.destination, sizeX: state.sizeX.destination, y: state.y.destination, sizeY: state.sizeY.destination,
}, (circuit, input) => ({
  bit: emitAll(circuit, [
    atLeastZero(circuit.roundAffine([[input.localX, 1], [input.x, -1]])),
    aboveZero(circuit.roundAffine([[input.x, 1], [input.sizeX, 1], [input.localX, -1]])),
    atLeastZero(circuit.roundAffine([[input.localY, 1], [input.y, -1]])),
    aboveZero(circuit.roundAffine([[input.y, 1], [input.sizeY, 1], [input.localY, -1]])),
  ], {booleanAtom: true}),
}))
const click = program.firstActive(hit.bit, keys.gate2D, 'click selection')
```

Two rules keep a stage boundary from changing arithmetic that one flat circuit would have produced. First, the builder composes a small affine wire (fewer than 4 terms, not a preserved rounding point) into its consumers. When a stage exports such a wire, the program records its terms, and a later stage that imports the wire rebuilds the affine from imported terms, so its consumers compose it the same way. Second, a stage lays out its imported cells in creation order, so a sum that sorts its terms by wire number sorts them the same way as in a flat build. `staged.test.ts` compares a two-stage program with a hand-built flat circuit: a shared stage exports `boxWidth = 0.1 × relu + 0.3`, and a map stage computes `3 × boxWidth + factor + 2`. With the rebuild, all 600 values over 200 widths equal the flat circuit's. Built with `new StagedProgram({rebuildSmallAffines: false})`, the map stage imports the stored box width, and 252 of the 600 values differ, because the product and the bias round at a different point. The test checks the second rule only through the order of the stage's imported cells. On the gallery and IndirectOS, turning the rebuild off changes few values; see "The rebuild rule on the workloads".

A map stage that returns an imported shared value returns that shared value, not a new field. The random program test ran into this: a reduction refuses a shared value as a field, so a per-item output has to read some field.

### The executors

- `expand.ts` builds the duplicated circuit, today's approach, as the reference. Shared stages are copied once and map stages once per item, operation by operation, with the same kinds, biases, coefficients and term order and renumbered wires. The copy bypasses the builder's normalization, so a copied sum keeps its accumulation order and no consumer recomposes a copied wire. Operations that read no per-item wire come out identical for every item and deduplicate through the builder's expression table. Each reduction is lowered into atoms that take the same FP32 steps as its executor loop.
- `executor.ts` runs shared stages as generated JS and map stages as generated JS with one instance loop per stage over struct-of-arrays columns (`columns.ts`, adapted from codegen's instance loop, which reads and writes packed tables instead). The part of a map stage that reads no per-item cell runs once per evaluation. Reductions are plain loops.
- `gpu-executor.ts` replaces a map stage's instance loop with a WGSL compute shader emitted by `wgsl.ts` (copied from codegen, with its max guard), and keeps shared stages, each map stage's shared part, and reductions on the CPU. Every GPU stage packs its per-item inputs, uploads them, dispatches, reads back, and unpacks, and the timings keep those parts apart. By default a stage goes to the GPU only when its per-item part has at least 8 rows.
- `codegen.ts`, `instance.ts`, `wgsl.ts`, `wgsl-interpreter.ts` and `gpu-runner.ts` are copies from lab/ui-exploration/codegen.

### Workloads

- `gallery-staged.ts`: the gallery's render path, section by section like `gallery-circuit.ts` (copied from lab/ui-exploration/gallery), as 6 map stages over photos, 14 one-operation map stages over row arrays, 9 shared stages, and 31 reductions. What changed because a map stage is written once:
  - Each photo's constants are per-item constants, read by products or gathers instead of being weights. For example the 2D width is `min(boxMaxSizeX × widthFactor, w)` with `widthFactor` a per-item constant, and a photo's column for the current column count is a gather over the column one-hot with its 7 per-item columns as candidates.
  - The focus one-hot comes from each photo comparing its own index with the new focused index, `[d = 0]` for `d = newIndex − index` as `relu(d + 1) − 2 relu(d) + relu(d − 1)`. `gallery-circuit.ts` builds one shared chain of ramps. The blur of the focused photo's neighbors is `[|d| ≤ 1]`, so no photo reads a neighbor.
  - Rows get their own arrays, one per column count from 1 to 7. `groupMax` takes each row's maximum height, a map stage adds the gap, `prefixSum` gives row tops, and `gatherIndexed` reads each photo's row values back at its per-item row index.
  - The prefix sums add the gap into each value first (width + 52), where `gallery-circuit.ts` adds 52 × k as the bias of each row and then adds k widths.
- `gallery-engine.ts`, `gallery-host.ts`, `gallery-differential.ts`: one surface over four engines (the original circuit, the staged executor, the staged program's duplicated circuit, and a tee that steps two engines from the same cells every frame and compares every output), the host copied from gallery-app.ts, and the differential harness copied from gallery's differential.ts, which runs the native index.ts beside an engine. `reference.ts`, `fake-dom.ts`, `photo-data.ts` and `kit.ts` are copies from lab/ui-exploration/gallery. `synthetic-photos.ts` makes photo lists of any length with Midjourney's aspect ratios.
- `gallery-session.ts`: a deterministic 220-frame session that needs no native index.ts, for the GPU scripts.
- `indirect-os-staged.ts` and `indirect-os-compare.ts`: IndirectOS with windows (4), dock items (4) and photos (12) as instance arrays, compared frame by frame with the root `window-manager.ts` machine.
  - The frontmost window under a press is a `max` over each window's key, rank + 1 when the press hits the window and 0 otherwise, and each window compares its own key with the maximum. window-manager.ts scans ranks from the top.
  - The stack update is a `sum` of selected × rank, then each window computes its next rank bits with the same products as window-manager.ts.
  - Photos' thumbnail targets come from each thumbnail comparing its own index with the focused index: the cyclic offset, distance and spread are integer tables read through per-item equality bits. photo-gallery.ts writes them as build-time weights over all 12 focus bits.
  - Photos' click priority (previous, next, a thumbnail, the main image) is a `firstActive` over thumbnails plus a shared stage for the fixed order around it, and the previous and next neighbors come from `gatherIndexed` at per-item constant indices.
- `demo.html`, `demo.ts`, `demo-model.ts`, `demo.css`: the browser demo. `demo-model.ts` holds the logic, uses Brent-Kung prefix sums (see "Precision"), and projects only photos whose occlusion bit is 1.

## Measured results

Counts are exact. Timings are medians on a laptop shared with a dozen other agents (load average about 10 during the scaling runs), so read them as rough. Bun 1.4.0, Deno 1.42.4, Node 23.10 with `webgpu` 0.6.1, Apple GPU through Metal.

### Which reductions keep FP32 results identical to the duplicated circuit

Every reduction states one fold order. The executor's loop and the lowering in the duplicated circuit take the same FP32 steps, so the staged executor matches its duplicated circuit bit for bit, and a test checks it on 30 random staged programs over every reduction kind, four evaluations each with writeback, with both prefix lowerings. In those programs, the first active item and the argmax read a per-item cell that the test redraws before every evaluation, and the test checks both against plain loops over the executor's columns: over the 232 evaluations of programs with more than one item, the first active index was nonzero in 114 and the argmax index in 205. Another test walks each item's copy of each stage in the duplicated circuit and checks that the copy has exactly the stage's live operations. What a reduction doesn't keep is agreement with a circuit that folds in a different order. f below is `Math.fround`.

| Reduction | Fold order (executor and lowering) | Lowering in the duplicated circuit | Results under a different fold order |
| --- | --- | --- | --- |
| `sum`, `countBits` | `f(...f(f(0 + v0) + v1)... + v(n−1))` | one preserved sum over n terms | bits and integers below 2^24 are exact in any order; fractional sums can differ |
| `prefixSum`, sequential | `p = f(bias)`, then `before_i = p`, `p = f(p + v_i)`, `through_i = p` | a triangle (one preserved sum per output: 1 layer, n²/2 weights) or a chain (one pair sum per output: n layers); both give the same bits | fractional sums differ from other orders, see "Fold orders" and "Precision" |
| `prefixSum`, Brent-Kung | pair sums `f(a + b)` in the Brent-Kung network, then `through_i = f(f(bias) + inclusive_i)` | the same network, 2 log2 n layers | differ from the sequential order by FP32 rounding, and drift far less from float64 at large totals |
| `firstActive` | the first item whose bit is 1, when the gate is 1 | `emitFirstSetBit`'s tournament plus preserved index sums | exact bits in any construction |
| `argmax` | `emitArgmax`'s tournament over scores in 0..1, ties to the lower index | the same tournament with preserved comparisons | a different pairing can pick differently only between near-equal scores |
| `max`, `groupMax` | `m = f(v_i + max(0, f(m − v_i)))` in item order | 3 atoms per combine | exact for integers; a balanced tree can differ for fractional values |
| `gatherAt` | `f(0 + v[index])`, and 0 when present is 0 | the index one-hot and a lowered gather, gated by present | exact reads |
| `gatherIndexed` | `out_i = from[index_i]` | direct wire references, no atoms | exact reads |
| `scatter` | bit_i = present and i = index, or `f(bit_i × value)` | the index one-hot ANDed with present | exact |

### The gallery at 221 photos

The staged gallery builds in about 5 ms and generates 31 JS functions.

| Part | Live operations | Layers | Stored weights |
| --- | ---: | ---: | ---: |
| map: click hit test | 10 | 4 | 19 |
| map: sizes and focus relation | 25 | 7 | 56 |
| map: grid targets and hover (4 gathers) | 19 | 8 | 32 |
| map: destinations | 20 | 4 | 86 |
| map: anchor predicate | 5 | 5 | 9 |
| map: springs and occlusion | 154 | 13 | 311 |
| all map stages over photos, per photo | 233 | | |
| map stages over rows, per row of each column count | 2 | | |
| shared stages, of which the clock and spring matrix are 248 | 401 | | |

Circuit sizes:

| Circuit | Live operations | Layers | Stored weights | Gather reads |
| --- | ---: | ---: | ---: | ---: |
| gallery-circuit.ts, triangle prefix sums (the default) | 48,411 | 61 | 174,708 | 457 |
| gallery-circuit.ts, Brent-Kung prefix sums | 49,837 | 61 | 116,442 | 457 |
| staged program, duplicated, sequential prefix sums as triangles | 55,627 | 64 | 182,635 | 892 |
| staged program, duplicated, sequential prefix sums as chains | 55,627 | 260 | 122,314 | 892 |
| staged program, duplicated, Brent-Kung prefix sums | 57,135 | 67 | 124,533 | 892 |

Duplicated, the staged gallery has 7,216 more live operations than gallery-circuit.ts, about 33 per photo: products for per-item constants that gallery-circuit.ts puts in weights (the width factor, 1/aspect, aspect, h/w), per-photo ramps for the focus relation, and gathers of the 7 row variants into each photo.

### Correctness of the staged gallery

Against the native index.ts, with the harness and the traces from lab/ui-exploration/gallery (same seeds, viewports and event mixes, so the counts match that README):

| Run | Frames | Decision checks | Mismatches | Largest continuous errors |
| --- | ---: | ---: | ---: | --- |
| 6 random traces, 600 frames each, dyadic frame durations, free-running | 3,600 | 957,258 | 0 | destination x 0.25px, y 0.12px, style transforms 0.05px |
| 6 random traces, microsecond timestamps with jitter, free-running | 3,600 | 939,289 | 0 | destination x 0.27px, style transforms 0.10px |
| scripted trace | 420 | 126,182 | 0 | destination x 0.18px, style transforms 0.007px |

Against the staged program's own duplicated circuit, every frame of 2 random traces of 300 frames: 4,122,000 values (every output and every written-back cell of every photo), all bit-identical. The Brent-Kung variant against its duplicated circuit over the scripted trace: 2,885,400 values, all bit-identical.

Against gallery-circuit.ts, with the tee copying all 4,004 cells from gallery-circuit.ts into the staged program before each frame, so each frame compares one evaluation from identical state:

| Run | Values compared | Bit-identical | Differing decisions | Largest differences |
| --- | ---: | ---: | ---: | --- |
| scripted trace | 2,885,400 | 88.2% | 0 | destination x 0.031px, x velocity 0.19px/s |
| 6 dyadic traces | 24,732,000 | 86.7% | 102, in 51 frames: still animating | destination x 0.055px, x velocity 0.31px/s |
| 6 microsecond traces | 24,732,000 | 86.1% | 64, in 32 frames: still animating | destination x 0.063px, x velocity 0.34px/s |

Every visible, focused and blurred bit, every column count, anchor, cursor, focus and step count was identical. The only differing decision is the "still animating" bit, in 51 and 32 of 3,600 frames. From identical cells, both circuits recompute this frame's destinations with different fold orders, and a spring's new displacement is the old destination minus the new one plus the stored displacement, so a spring within a few 1e-4 px of the 0.01 px settle threshold settles in one circuit and not in the other. Against index.ts, free-running, the staged program's settle timing matched every frame. Scale and every decision that only reads integers were bit-identical; sizes, destinations and velocities carry the rounding differences.

### Fold orders

The scripted trace, one evaluation from identical cells per frame:

| Pair | Values compared | Bit-identical | Differing decisions | Largest differences |
| --- | ---: | ---: | ---: | --- |
| staged sequential prefix sums against staged Brent-Kung prefix sums | 2,885,400 | 90.7% | 0 | strip destination x 0.164px, placeholder height 0.0078px |
| staged Brent-Kung against gallery-circuit.ts | 2,885,400 | 83.2% | 0 | destination x 0.19px |
| staged Brent-Kung against its duplicated circuit | 2,885,400 | 100% | 0 | none |

The strip's lefts are prefix sums that pass 100,000 px on this trace, where FP32 values are 1/128 px apart, so the order of additions moves destinations by a few of those steps.

### The rebuild rule on the workloads

`report.ts rebuild` builds the gallery and IndirectOS again with `rebuildSmallAffines: false` and reruns their comparisons.

| Program | Live operations per item | Duplicated circuit: live operations / layers / stored weights |
| --- | --- | ---: |
| gallery at 221 photos, with the rule | 233 per photo, 401 shared | 55,627 / 64 / 182,635 |
| gallery at 221 photos, without the rule | 228 per photo, 403 shared | 56,515 / 64 / 181,970 |
| IndirectOS, with the rule | 681 per window, 19 per dock item, 270 per photo, 254 shared | 6,282 / 215 / 13,346 |
| IndirectOS, without the rule | 671 per window, 20 per dock item, 263 per photo, 268 shared | 6,266 / 214 / 13,255 |

Stepping the gallery without the rule beside the gallery with it, from identical cells every frame of the scripted trace, 217 of 2,885,400 values differ, all of them x destinations and x springs, by at most 0.00003 px and 0.0005 px/s, with sequential and with Brent-Kung prefix sums alike, and no decision differs. Against gallery-circuit.ts, the gallery without the rule has 26 fewer identical values (2,543,509 against 2,543,535 with sequential prefix sums, 2,401,234 against 2,401,260 with Brent-Kung). Without the rule, the staged executor still matches its own duplicated circuit on all 2,885,400 values. IndirectOS without the rule computes all 94,380 values of the session exactly like IndirectOS with it, so it matches window-manager.ts on the same 93,249 values, with 0 decision mismatches. On these workloads the rule mainly changes operation counts; the test described under "The builder" shows the kind of arithmetic the rule does change, an exported affine with a fractional coefficient and bias.

### Scaling to 1,000 and 10,000 photos

Brent-Kung prefix sums in every circuit, a mid-animation frame (photo 40 open, five frames in), µs per evaluation. The staged executor's time includes writing next values back. The duplicated circuit and gallery-circuit.ts run through `createTensorEvaluator`, which also checks source ranges. index.ts runs natively against the fake DOM while alternating between opening and closing a photo.

| Photos | 221 | 1,000 | 10,000 |
| --- | ---: | ---: | ---: |
| staged program: build + generate JS | 4 + 2 ms | 5 + 2 ms | 22 + 3 ms |
| staged program: per-photo operations | 233 | 233 | 233 |
| staged executor | 65 µs | 310 µs | 4,106 µs |
| duplicated circuit: live operations / layers | 57,135 / 67 | 257,433 / 71 | 2,571,887 / 80 |
| duplicated circuit: stored weights | 124,533 | 560,955 | 5,603,733 |
| duplicated circuit: expand + compile | 49 + 39 ms | 235 + 218 ms | 2,626 + 2,099 ms |
| duplicated circuit, executor | 546 µs | 2,569 µs | 43,027 µs |
| gallery-circuit.ts, Brent-Kung: live operations / layers | 49,837 / 61 | 228,506 / 67 | not built: coordinates past its ±2^22 px range |
| gallery-circuit.ts, executor | 459 µs | 2,287 µs | |
| index.ts natively | 21 µs | 100 µs | 3,055 µs |
| heap after the row | 215 MB | 402 MB | 1,969 MB |

The slowest steps of the staged executor at 10,000 photos: springs and occlusion 1,809 µs, destinations 539 µs, grid targets 538 µs, sizes 471 µs, the click hit test 80 µs, the anchor predicate 53 µs; the strip's prefix sum 26 µs. At 1,000 photos: springs 119 µs, grid 38 µs, destinations 35 µs, sizes 22 µs, and every other step, reductions included, at most 2.7 µs.

Earlier exploratory runs on a quieter machine measured the staged executor at 183 µs for 1,000 photos and 2,222 µs for 10,000, and the 1,000-photo duplicated circuit at 1,668 µs with Brent-Kung prefix sums, 1,727 µs with chain prefix sums (1,039 layers), and 2,795 µs with triangle prefix sums (1.8 million stored weights). The 10,000-photo duplicated circuit with chain prefix sums has 2,500,167 operations in 10,039 layers.

### Precision past a million pixels

At 10,000 photos the page is millions of pixels tall and the strip about 8 million pixels long, past gallery-circuit.ts's declared ±2^22 px, so the scaled programs declare ±2^24 px. Synthetic photos, random traces against index.ts running the same photos, seeds 7000 (1440×900) and 7001 (2560×1400), 120 frames at 10,000 photos and 300 at 1,000:

| Photos | Prefix sums | Run | Decision checks | Mismatches | Largest errors |
| --- | --- | --- | ---: | ---: | --- |
| 1,000 | sequential | free-running | 618,401 | 0 | destination x 4.5px, y 1.6px, style transforms 0.059px |
| 1,000 | Brent-Kung | free-running | 618,401 | 0 | destination x 0.21px, y 0.067px, style transforms 0.031px |
| 10,000 | sequential | free-running | 2,407,967 | 74, all in seed 7000 | seed 7001: destination x 472.8px (strip lefts), y 40.7px (row tops), style transforms 13.3px; seed 7000 diverged, e.g. photo 0's destination x off by 2.7 million px |
| 10,000 | sequential | state copied from index.ts every frame | 2,407,967 | 55, all in seed 7000 | the same as free-running |
| 10,000 | Brent-Kung | free-running | 2,408,107 | 0 | destination x 3.3px, y 1.1px, style transforms 0.18px |
| 10,000 | Brent-Kung | state copied from index.ts every frame | 2,408,107 | 0 | destination x 3.3px, y 1.1px, style transforms 0.23px |

With sequential sums, seed 7000 first changed the cursor over a box near 4.4 million px, then at frame 98 the anchor search picked row start 6208 where index.ts picked 6206, and the trace diverged from there. With state copied every frame the same decisions still flipped, so they come from one evaluation's arithmetic, not from state accumulated over frames. A sequential running sum adds each row's height, a few hundred pixels, to a total that already passes a million pixels, where FP32 values are 1/8 px apart, and thousands of those rounded additions can lean the same way: 40.7 px after about 5,000 rows. The strip's lefts are a running sum over all 10,000 photo widths, and near 2.5 million px, where FP32 values are 1/4 px apart, the last photo's left drifted 472.8 px. Each precision result in `results.json` lists these maxima per seed under `perTrace`. In the Brent-Kung network most additions combine sums of similar size, two rows, then two pairs, and only the last few levels add at the total's size, so the error follows the number of levels instead of the number of rows. The fold order that parallelizes is also the more precise one here.

### The per-photo stages on the GPU

`wgsl.test.ts` emits every map stage of the gallery (24 synthetic photos), with and without the max guard, interprets the shaders with strict f32 rounding, and compares with the executor's columns over 11 session frames: all identical.

Headless, the first frames of the 220-frame session (sequential prefix sums), comparing every stored value of the program with the CPU executor every frame:

| Stack | Photos | Frames | Values compared | Differing | CPU executor | GPU pipeline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dawn (Node) | 221 | 60 | 1,668,960 | 0 | 0.80 ms | 2.2 ms |
| Dawn (Node) | 1,000 | 60 | 7,528,380 | 0 | 0.59 ms | 2.6 ms |
| Dawn (Node) | 10,000 | 20 | 25,076,340 | 0 | 9.1 ms | 12.2 ms |
| wgpu (Deno) | 221 | 60 | 1,668,960 | 0 | 0.57 ms | 74 ms |
| wgpu (Deno) | 1,000 | 60 | 7,528,380 | 0 | 0.68 ms | 74 ms |
| wgpu (Deno) | 10,000 | 60 | 75,229,020 | 0 | 7.2 ms | 78 ms |

The GPU pipeline runs the 5 per-photo stages on the GPU and everything else on the CPU. CPU executor times come from Node's and Deno's JITs, so compare them within a row only. Dawn's Node bindings crashed (exit 139) during a 60-frame run at 10,000 photos, after the first two counts in the same process had completed; a separate 20-frame run completed. codegen's README reports the same crash.

Per stage through Dawn: at 1,000 photos, uploading the per-photo inputs about 0.17 ms, dispatch and readback about 0.21 ms, packing and unpacking under 0.1 ms. At 10,000 photos, upload 0.53 to 0.68 ms, dispatch and readback 0.61 to 0.65 ms, and packing columns into the upload table up to 1.3 ms. Through Deno, each readback waits about 15 ms in `mapAsync`. Shaders compiled in 1 to 12 ms.

| Stage | Shader statements | max guards |
| --- | ---: | ---: |
| click hit test | 15 | 12 |
| sizes and focus relation | 45 | 54 |
| grid targets and hover | 89 | 50 |
| destinations | 49 | 91 |
| springs and occlusion | 204 | 235 |

In an earlier configuration every map stage went to the GPU, including the 14 one-operation row stages (`gpu-results-wgpu-every-map-stage.json`). Through Deno that compared the same 1,668,960, 7,528,380 and 75,229,020 values with 0 differing, and took about 290 ms per frame, because each of the 20 readbacks waited about 15 ms.

### IndirectOS

| Circuit | Live operations | Layers | Stored weights | Widest layer |
| --- | ---: | ---: | ---: | ---: |
| window-manager.ts | 5,253 | 192 | 11,598 | 123 |
| staged program, duplicated | 6,282 | 215 | 13,346 | 242 |

Live operations of the staged program by axis: 254 shared, 681 per window (4), 19 per dock item (4), 270 per photo (12), in 7 shared stages, 8 map stages and 17 reductions. The largest per-item stages are the window springs and projection (430 operations, 59 layers) and the thumbnails and photo boxes (204 operations, 59 layers).

Against window-manager.ts over a 220-frame session (drag window 0 by its title bar, resize it, close window 1 and reopen it from the dock, maximize Photos, open photo 0, next twice, previous, close the lightbox, restore Photos, minimize window 1, with a 90 ms stall), comparing all 201 next source cells and all 228 projected outputs every frame:

| Run | Values compared | Bit-identical | Differing decisions | Differences |
| --- | ---: | ---: | ---: | --- |
| free-running | 94,380 | 98.8% | 0 | thumbnail centers up to 0.0012px, their velocities up to 0.013px/s |
| cells copied from window-manager.ts every frame | 94,380 | 99.3% | 0 | thumbnail centers up to 0.0010px, velocities up to 0.0023px/s |

Every window, dock item, stack bit and photo grid output was bit-identical. The thumbnail falloff multiplies `f32(−0.22)` by an integer distance, where photo-gallery.ts rounds `−0.22 × k` once as a weight. The test checks that each session step did what it says, e.g. window 0 at 114, 104 after the drag and photo 2 focused after two nexts, and pins both circuits' sizes from the table above.

Rough µs per evaluation: window-manager.ts through `evaluateTensor` 59 µs, the staged executor 9 µs. Most of that difference is generated JS rather than staging: codegen measured about 3 µs for the flat IndirectOS circuit as generated JS.

## What this shows about how far the approach goes

### What fit well

- One per-item program with reductions between stages covered the whole gallery render path with 233 operations per photo, and the same program ran at 221, 1,000 and 10,000 photos without changing. The work per frame still grows with the photo count, as it does for a shader, but the program, its build time (22 ms at 10,000 photos) and its generated code stay the same size. The duplicated circuit reaches 2,571,887 live operations, 5.6 million stored weights, 4.7 s to expand and compile, and about 2 GB of heap at 10,000 photos, and evaluates in 43 ms where the staged executor takes about 2 to 4 ms and index.ts 3 ms.
- Decisions stayed exact. The staged gallery made no decision differently from index.ts in about 2 million free-running checks at 221 photos, 618,401 at 1,000 photos, and 2.4 million at 10,000 photos with Brent-Kung prefix sums. The staged executor, the duplicated circuit and the GPU agreed bit for bit in every comparison, including 75 million values at 10,000 photos through wgpu and 25 million through Dawn.
- Every reduction the gallery and IndirectOS needed had one stated fold order that both a loop and a lowering take: sums, counts, prefix sums, the first set bit, maxima within groups, and reads at shared or per-item indices. At 10,000 photos the slowest reduction, the strip's prefix sum, took 26 µs of a 4.1 ms frame.
- Shader habits replaced cross-item wiring. Each photo compares its own index with the focused index instead of reading a shared one-hot chain; neighbors come from reads at per-item constant indices; row values come from per-row arrays and are read back by row index. IndirectOS's frontmost window became a maximum over per-window keys.
- The parallel fold order doubled as a precision fix. At 10,000 photos, Brent-Kung prefix sums kept every decision equal to index.ts where sequential sums flipped 74, because most of their additions combine values of similar size.
- The staged executor is cheaper than the duplicated circuit at every size: 65 against 546 µs at 221 photos, 310 against 2,569 µs at 1,000, and 4,106 against 43,027 µs at 10,000. Per-item stages keep generated functions small, which is the fix codegen found for JavaScriptCore's size limit, and there is no per-row interpretation left.
- The staged IndirectOS computed every window, dock and grid output bit for bit like window-manager.ts, split into 15 stages and 17 reductions. That result doesn't depend on the rebuild rule for small affines: with the rule off, no IndirectOS value changed over the session, and on the gallery's scripted trace 217 of 2,885,400 values moved by at most 0.00003 px. On these workloads the rule mainly changes operation counts.

### What got awkward

- A per-item constant turns a weight into an atom. `gallery-circuit.ts` writes each photo's width factor as a coefficient, while a stage written once multiplies by a per-item cell. That costs about 33 more operations per photo in the duplicated circuit, and a different accumulation order, which accounts for most of the 12 to 14% of values that differ from gallery-circuit.ts. IndirectOS grew from 5,253 to 6,282 operations and from 192 to 215 layers for the same reason: its thumbnail tables became per-item equality bits and products.
- Fold order is part of the meaning. gallery-circuit.ts's prefix sums add 52 × k as each row's bias first, a fold order no incremental loop reproduces; reproducing it needs the n²/2 additions of its triangle. Switching the staged prefix sums from sequential to Brent-Kung left 90.7% of values identical and moved strip destinations by up to 0.164 px. Decisions that compare positions inherit the difference: from identical cells, the "still animating" bit differed from gallery-circuit.ts in 51 and 32 of 3,600 frames, for springs just at the settle threshold.
- FP32 at 10,000 photos. Even with Brent-Kung sums, destinations far down the page differ from index.ts's float64 values by up to 3.3 px, and positions there are 1/8 to 1/2 px apart. With sequential sums, in the trace whose decisions all matched, strip lefts drifted 472.8 px, row tops 40.7 px and onscreen boxes 13.3 px; in the other trace, decisions flipped and the trace diverged.
- A runtime index into another array doesn't lower into a flat circuit. A photo's row depends on the runtime column count, so the program keeps 7 row arrays and gathers the current variant in each photo. `gatherIndexed` only accepts per-item constants, because a per-item runtime index into n rows would need an n-member one-hot per photo in the duplicated circuit.
- The GPU pays a round trip per stage. The gallery alternates per-photo maps with CPU reductions, so each of the 5 GPU stages uploads and reads back: about 0.4 ms each through Dawn at 1,000 photos, 1.2 ms at 10,000 plus up to 1.3 ms of packing, and 15 ms each through Deno. At 1,000 photos the GPU pipeline took 2.6 ms and the CPU executor 0.6 ms; at 10,000, 12.2 ms against 9.1 ms under Node. Keeping fields on the GPU needs the reductions there too.
- Creation order and passthroughs need care: imported cells are laid out by creation order so sorted sums keep their order, and a map stage that returns a shared input returns the shared value, which a reduction then refuses as a field.
- Dawn's Node bindings crashed in one long run at 10,000 photos.

### What stayed outside the circuit

- The pipeline itself. A staged program is no longer one matmul per frame but a sequence of stages and loops, run by JS or by GPU dispatches between CPU loops. The duplicated circuit exists as the reference and for size comparisons.
- Per-item constant tables: each photo's row and column for 7 column counts, its row-start bits, and its aspect-derived factors are computed in JS when building.
- Everything the gallery README lists: the URL hash, `scrollTo`, DOM nodes and style strings, prompt selection, frame durations, and initial spring state. The demo also decides in JS which DOM nodes to create and remove from the visible bits.
- GPU buffer management, packing, and readback.

## Open questions and next steps

- Reductions on the GPU: counts and the first set bit as parallel reductions (exact on bits), Brent-Kung prefix sums as GPU passes with the max guard (the same fold order as the CPU loop), gathers as indexed reads inside the next shader, and grouped maxima over at most 7 items per row. Then fields stay on the GPU, the shared stages read back a few scalars, and a frame becomes a handful of dispatches plus one readback of the visible photos.
- Per-item weight columns: an atom whose coefficient comes from a per-item column instead of a product would keep the duplicated circuit's accumulation order where each item's constants are weights, and remove the extra operations per photo.
- Runtime indices across arrays, e.g. rows for the current column count, with a lowering that chooses among a few variants.
- Precision past a million pixels: prefix sums anchored at the focus or at the scroll anchor (a masked prefix sum from that item outward) would keep onscreen positions small at any photo count, and a two-part sum (whole pixels and the fraction) would keep the fraction precise.
- Skipping settled photos: a compaction step that runs the spring stage only over photos still moving, which changes the cost from all photos to the moving ones.
- Per-array validation: phase 2's derived validator checks a flat source table; per-array ranges would check columns in a loop.
- Whether the rebuild rule should stay. It makes a stage boundary compose a small affine the way one circuit would, which matters for exported affines with fractional coefficients and biases. But on the gallery and IndirectOS it changed 217 of 2,885,400 and 0 of 94,380 values, while it adds 5 operations per photo to the staged gallery, removes 888 from the gallery's duplicated circuit, and adds 16 to IndirectOS's.

## Browser check

2026-09-13, Chrome. I served the page with `bun lab/ui-exploration/instanced-items/demo.html` in a 1,160 by 853 CSS px viewport, which gives 4 columns. Chrome reported the tab as hidden, so for most checks a console script replaced `window.requestAnimationFrame` with callbacks driven by a Worker timer every 16 ms, running only while a frame was pending. `~/Downloads/ui-exploration-instanced-items-demo.gif` has only 7 frames, since the recorder dropped the rest. No file in this folder changed.

### What worked

- The page loads with no console errors, at 10,000 photos and with `?count=221`. The HUD shows 233 operations per photo in 6 map stages, 401 shared operations and 31 reductions, as in the tables above. At 10,000 photos the page is 851,495 px tall. With `?count=221` it's 18,453 px tall and draws the real prompts, e.g. "Miniature watermelon delicately balanced on fingertip".
- Scrolling through all 10,000 photos. I scripted jumps to 7 positions from the top to the bottom (0, 3,000, 40,000, 150,000, 425,000, 700,000 and 850,642 px) with `window.scrollTo` and a dispatched `scroll` event, since the hidden tab only fires scroll events when a frame renders. At each position, 12 to 16 photos were attached, in contiguous rows around the viewport, e.g. photos 1,760 to 1,775 at 150,000 px and photos 9,988 to 9,999 at the bottom. A few attached photos sat just past the viewport's top or bottom edge, e.g. photo 4,995 at y −356 to −48. The occlusion test does that on purpose: it widens the viewport by `browserUIMaxSizeTop` and `browserUIMaxSizeBottom`, as index.ts does. A real wheel scroll of 10 ticks also worked, and the page caught up to scrollY 1,000 with photos 8 to 23 attached.
- With the real mouse and keyboard: hovering a photo sets the zoom-in cursor, and moving into the gap between columns sets it back to auto. A click on photo 14 opened the strip: the hash became `#synthetic-14`, the body got `overflow: hidden` and the zoom-out cursor, photo 14 was centered at 856 by 635 px, and 3 photos were attached. ArrowRight moved the strip to `#synthetic-15`, ArrowLeft back to `#synthetic-14`, and Escape cleared the hash and returned to the grid at the same scroll position, with photos 8 to 23 attached again.
- With no input, the page stops drawing frames once the springs settle: 0 frames in 3 s.

### Frame time

The HUD's "evaluate" line is a running average in which each new frame counts for 10%. My clock timed each frame's callback, i.e. evaluation, DOM writes and the HUD update. At 10,000 photos, the same work took very different times depending on when I measured:

| When | Frames | Median frame time | HUD evaluate afterward |
| --- | ---: | ---: | ---: |
| mouse moves every 16 ms for 7.8 s, the first time | 423 | 19.0 ms | 17,802 µs |
| the wheel scroll, hover, the strip and the arrow keys | about 400 | not recorded | 4,249 to 5,020 µs |
| mouse moves every 16 ms for 6.1 s, the second time | 379 | 15.0 ms | 14,741 µs |
| mouse moves every 200 ms for 4 s (each move started about 10 frames of animation) | 231 | 12.3 ms | |
| mouse moves every 16 ms for 2 s | 211 | 14.9 ms | 13,965 µs |
| four scroll jumps between 1,000 and 1,400 px | 112 | 14.2 ms | 13,354 µs |

DOM writes for 12 to 16 visible photos took 36 to 214 µs. The machine's load average was 4.68 while I measured. I didn't find why the frames took about 4 ms in one part of the session and 12 to 19 ms in the others. The last three runs, spaced mouse moves, back-to-back mouse moves and scroll jumps, took about the same time, so the kind of input doesn't explain the difference. At 15 ms, evaluating 10,000 photos uses most of a 16.7 ms frame. With `?count=221`, the HUD read 10,190 µs after only a few frames on load, too few for the running average to mean much.

### What didn't work, or looks off

- Nothing broke. The open question is the frame time above: in Chrome at 10,000 photos, a frame took from about 4 to 19 ms depending on when I measured, against the table's 4,106 µs for the staged executor in Bun.
- Not checked: resizing the window, selecting a caption, and frame pacing in a visible tab.

### Fixes

None.
