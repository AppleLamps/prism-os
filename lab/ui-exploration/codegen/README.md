# Execution backends: generated JS, instance-parallel evaluation, and WGSL

This prototype asks two questions about the IndirectOS execution model. How much faster does the same compiled circuit run once the interpreter goes away? And what new UI tools appear when one circuit runs over many instances, e.g. every pixel of a canvas, every cell of a grid, or thousands of viewport sizes?

It builds three backends for the program that `compileTensorProgram` produces: plain JavaScript split into small functions, an instance-parallel evaluator (generated JS and a batched interpreter), and WGSL compute shaders. Every backend is checked bit for bit against the reference evaluator, and the shaders were run on this machine's GPU through two WebGPU implementations, wgpu and Dawn. Both translate WGSL to Metal, so both end in Apple's Metal shader compiler. `numeric-ui-core.ts` is unchanged; everything imports the shared runtime.

## What it is and how to run it

From the repository root:

- `bun test lab/ui-exploration/codegen` runs the 20 tests (about 3 seconds).
- `bunx tsgo -p lab/ui-exploration/codegen` typechecks the folder.
- `bun lab/ui-exploration/codegen/report.ts` runs the timing study and writes `results.json` (several minutes; it spawns fresh Bun processes for cold-start numbers).
- `deno run --unstable-webgpu --allow-all lab/ui-exploration/codegen/gpu-headless.ts` runs every workload's shader on the GPU through Deno's WebGPU (wgpu, naga to Metal) and compares with the CPU. The saved output is `gpu-results-wgpu.json`.
- `DAWN_WEBGPU=/path/to/node_modules/webgpu/index.js node lab/ui-exploration/codegen/gpu-headless.ts` does the same through Dawn, the WebGPU implementation in Chrome. The `webgpu` npm package can be installed in any folder outside the repo, e.g. `npm install webgpu@0.6.1` in a scratch folder. The saved output is `gpu-results-dawn.json`.
- `bun lab/ui-exploration/codegen/demo.html` serves a page that renders each workload through generated JS or WebGPU and compares the two. The same shaders and the same runner module were verified headlessly through Deno and Dawn, and the page was checked in Chrome afterwards (see "Browser check" at the end).

## What was built

- `codegen.ts` flattens a compiled program into rows in execution order and writes one JavaScript statement per live value, grouped into functions of a bounded row count and compiled with `new Function`. Each statement keeps the executor's FP32 accumulation order, so results are identical. A few rewrites keep that exactness while removing work, e.g. `fround(1 * x)` is `x`, and a store into a `Float32Array` already rounds, so the outermost `fround` of a statement is dropped.
- `indirect-os-machine.ts` is a copy of `createWindowManagerMachine` whose step uses either the executor or generated JS, with the per-frame JavaScript validation switchable. It also holds a deterministic 240-frame session over IndirectOS's initial layout at 1280×800: drag window 0 by its title bar, resize it by its grip, close window 1 and reopen it from the dock, maximize Photos, click a photo in the Photos grid, go to the next photo and back, close the photo, restore Photos, and minimize window 1, with a 90 ms stall in the middle. Its test checks what's under each press with the press map's float64 reference, and that each event changes the state it should, e.g. window 0's width after the resize and window 1's open flag after the close.
- `instance.ts` splits a program into shared values and per-instance values. A value is per-instance when it reads a per-instance source cell, directly or indirectly. For example, in a per-pixel map of which window receives a press, the press position is per-instance and all window geometry is shared. The shared part runs once; the per-instance part runs over blocks of instances through two backends:
  - generated JS that loops over a block's instances inside each generated function, reading shared values as hoisted locals;
  - a batched executor that visits each row once per block and loops over the block's instances inside that row, so interpreting a row is paid once per block instead of once per instance.
- Four workloads. Three have an independent float64 JavaScript reference. candidate-gallery has none: its instance outputs are checked against the circuit's own reference evaluator, which confirms the backends compute the circuit's values but doesn't check the layout rules against a separate implementation.
  - `window-ownership.ts`: for every pixel, which IndirectOS window or dock item receives a press there, and which part of the window (title bar, a button, the resize grip). It reads IndirectOS's own source table, so a live session state feeds it directly. The hit tests and the frontmost selection are copies of the private helpers in `window-manager.ts`. The reference walks the stack from the top in float64.
  - `life-calendar.ts`: vibescript's life-calendar as one circuit over its 27,393 cells. Grid sizing (sqrt, runtime division, floor, ceil in the demo) is 141 threshold tests from phase one's `life-grid.ts`. Per cell, `week = round(cell / 7 - 3/7)`, and the row is a floor division by a runtime column count 7m, computed as `round(week · (1/m) - (m - 1)/(2m))` with both constants read from a shared one-hot. Hover is a per-cell hit test against the shared pointer, the way a shader tests every fragment, so the pointer never needs a floor division. The reference is the demo's own float64 code.
  - candidate-gallery over 256 viewport widths, and over a 256×256 grid of widths and heights, which draws a map of which layout wins where.
  - `sdf-shapes.ts`: rounded rectangles and circles as signed distances, with antialiased fills, a smoothstep hover falloff driven by the pointer, a glow ring, and the exact frontmost shape under each pixel. Lengths come from the largest projection over a fan of 16 directions instead of a square root, so no squares appear and 4K coordinates stay inside FP32's exact range. The reference uses `Math.hypot`.
- `wgsl.ts` emits one compute shader per instance program: one `let` per per-instance value, exact hexadecimal float literals, booleans as `select`, gather reads as `switch`, and a `max` guard described below. Without the guard, parentheses keep each row's grouping. `wgsl-interpreter.ts` interprets exactly the emitted WGSL subset with strict per-operation f32 rounding, so the emitted text is tested on the CPU. `gpu-runner.ts` runs a shader on any WebGPU device, and `gpu-headless.ts` runs all workloads plus a set of compiler probes.
- `render.ts` and `demo-model.ts` hold the canvas projections and the per-workload page logic, so tests cover them without a browser; `demo.ts` only wires the DOM.
- `candidate-gallery-copy.ts` and `window-manager-copy.ts` are copies of `candidate-gallery.ts` and `window-manager.ts` from the repo root, without the code that mounts their own pages at import time, which made `demo.html` throw while its modules loaded. Every module in this folder imports the copies, the tests and `report.ts` included. `root-copies.test.ts` checks that each copy compiles to the same program as its root module, and that the IndirectOS copy steps to bit-identical values over the scripted session.
- `random-circuit.ts` builds random circuits over every atom and macro, including argmax, first-active selections, and declared one-hot groups, for differential tests.

## Measured results

Structural counts are exact. Timings are medians on a laptop shared with about a dozen other agents, so read them as rough. Bun 1.4.0, Deno 1.42.4, Node 23.10 with `webgpu` 0.6.1, Apple GPU through Metal.

### Generated JS for one IndirectOS frame

IndirectOS with Photos: 5,253 live operations, 192 layers, 11,598 stored weights. The generated source is about 254 KB.

Warm cost of one evaluation, after 2.5 seconds of warmup:

| backend | functions | µs |
| --- | ---: | ---: |
| executor, reusable evaluator | | 30.1 |
| generated, 16 rows per function | 329 | 4.0 |
| generated, 64 rows per function | 83 | 3.0 |
| generated, 128 rows per function | 42 | 3.3 |
| generated, 128 rows, `Math.fround` called directly | 42 | 3.5 |
| generated, 256 rows per function | 21 | 3.1 |
| generated, 512 rows per function | 11 | 3.0 |
| generated, 1,024 rows per function | 6 | 12.6 |
| generated, one function | 1 | 220 |

The collapse at large functions is JavaScriptCore's optimization size limit. In fresh processes, the one-function version ran a frame in 225 µs with default options and in 13.7 µs with `BUN_JSC_maximumOptimizationCandidateBytecodeCost=100000000`, close to the 11.8 µs of 1,024 rows per function with default options. A browser page can't set that option, so small functions are the portable fix.

The frame loop, warm, µs per frame over the scripted session:

| frame loop | µs |
| --- | ---: |
| production `machine.step` (validation, `evaluateTensor`, writeback) | 111 |
| copy with the executor, no validation | 32 |
| copy with generated JS, no validation | 3.6 |
| copy with generated JS, with validation | 50 |

Once the interpreter is gone, the per-frame JavaScript validation costs about 13 times as much as the circuit.

Cold start, each row in a fresh process, over 3,000 frames of the session:

| backend | build and compile | generate + `new Function` | first frame | frames 2-10 | 11-100 | 101-1,000 | 1,001-3,000 | total for 3,000 frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| executor | 28 ms | | 0.60 ms | 172 µs | 49 µs | 30 µs | 29 µs | 100 ms |
| generated, 64 rows | 27 ms | 4.1 + 1.4 ms | 5.4 ms | 257 µs | 252 µs | 25 µs | 12 µs | 143 ms |
| generated, 128 rows | 27 ms | 3.9 + 1.5 ms | 5.3 ms | 260 µs | 249 µs | 75 µs | 12 µs | 158 ms |
| generated, 512 rows | 27 ms | 3.7 + 1.4 ms | 5.2 ms | 276 µs | 233 µs | 192 µs | 14 µs | 245 ms |
| generated, one function | 27 ms | 3.8 + 1.5 ms | 5.2 ms | 246 µs | 244 µs | 220 µs | 213 µs | 677 ms |

Generated code starts slower than the executor: the first frame costs about 5 ms, and the first hundred frames run at about 250 µs, because JavaScriptCore runs large functions in its interpreter before it optimizes them. Small functions reach about 12 µs after a thousand frames, and 3.6 µs only after seconds of continuous running. Over the first 3,000 frames the executor spends less total time.

### The instance axis on the CPU

Counts per workload, and nanoseconds per instance. "Per instance" baselines evaluate the whole circuit once per instance, shared part included, on a 2,048-instance slice. The two instance backends hoist the shared part and run blocks of 1,024 instances.

| workload | instances | live operations | shared rows | per-instance rows | per-instance depth | executor per instance | generated JS per instance | batched executor | generated instance loop | all instances, generated loop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IndirectOS ownership map, 1280×800 | 1,024,000 | 574 | 116 | 458 | 23 | 3,895 ns | 270 ns | 467 ns | 180 ns | 184 ms |
| life-calendar cells | 27,393 | 2,054 | 1,991 | 63 | 19 | 10,634 ns | 870 ns | 68 ns | 43 ns | 1.2 ms |
| candidate-gallery, 256 widths | 256 | 136 | 25 | 111 | 27 | 1,507 ns | 131 ns | 147 ns | 109 ns | 0.03 ms |
| candidate-gallery, 256×256 grid | 65,536 | 136 | 1 | 135 | 27 | 1,495 ns | 141 ns | 166 ns | 116 ns | 7.6 ms |
| SDF shapes, 560×360, 16 directions | 201,600 | 1,347 | 591 | 756 | 57 | 8,044 ns | 534 ns | 703 ns | 358 ns | 72 ms |
| SDF shapes, 560×360, 64 directions | 201,600 | 3,651 | 1,743 | 1,908 | 63 | 19,420 ns | 1,419 ns | 1,750 ns | 786 ns | 159 ms |

Hoisting matters most when most of a circuit is shared: the life calendar's per-cell part is 63 rows out of 2,054, so the instance loop is about 20 times faster than running generated code once per cell. The batched executor only beats per-instance generated code when rows are few; JavaScriptCore didn't turn its per-row loops into anything faster than the generated statements.

Block size, on the ownership map at 320×200 pixels, nanoseconds per pixel:

| instances per block | 1 | 16 | 256 | 1,024 | 4,096 | 16,384 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| generated instance loop | 224 | 186 | 196 | 202 | 212 | 240 |
| batched executor | 9,689 | 1,018 | 517 | 514 | 481 | 482 |

Generated code barely cares about block size; per-instance values fit in cache up to a few thousand instances per block. The batched executor needs hundreds of instances per block before its interpretation cost is amortized, and then stops improving.

### WGSL on two GPU stacks

Before emitting real workloads, I probed what the GPU shader compilers do to f32 arithmetic, with inputs chosen so that each optimization changes the bits. Counts are strict results out of the cases run; both stacks gave the same answers.

| probe | written as | wgpu (Deno) | Dawn (Node) |
| --- | --- | --- | --- |
| multiply-add, 8 cases | `a + b * c` | 0 strict, fused | 0 strict, fused |
| | product in a `let` | 0, fused | 0, fused |
| | product stored in a `var` | 0, fused | 0, fused |
| | `a + (b * c + zero)`, zero from a buffer | 0, fused | 0, fused |
| | `a + max(b * c, lowest)`, lowest from a buffer | 8 strict | 8 strict |
| boolean atom, 2 cases | `(a + 8388609) - 8388609`, also with `let` or `var` | 0, folded to `a` | 0, folded |
| | `max(a + 8388609, lowest) - 8388609` | 2 strict | 2 strict |
| sums with a different written order | `(c + a) + b` | strict in the probe shader, regrouped to `(a + b) + c` in a second shader | same |
| | `max(c + a, lowest) + b` | strict | strict |

The second shader is the scratch script `scratchpad/phase2/codegen/probe-barriers.ts` (backup: `~/github/indirect-scratch-backup/2026-09-15/scratchpad/phase2/codegen/probe-barriers.ts`), which also tried `select` and a multiplication by a runtime one as guards; both worked there too. The probe shader lives in `wgsl.ts` and runs in `gpu-headless.ts`.

So the compiler behind both stacks fuses multiply-adds across statements, regroups sums depending on the surrounding code, and folds the `(x + K) - K` shape that the boolean atom and `round` are built from. A `let`, a `var`, or a runtime zero doesn't stop any of this. Wrapping a result in `max(x, lowest)`, with `lowest = -3.4028235e38` loaded from a buffer, does, because the compiler can't prove the max is the identity, and for every finite x it returns x. With `guard: 'max'`, `wgsl.ts` wraps every inexact product and every partial sum, which comes to roughly one extra `max` per row.

Every workload, CPU generated JS against the GPU, outputs that differ in any bit (zeros of either sign count as equal):

| workload | outputs compared | no guard, wgpu | no guard, Dawn | max guard, wgpu | max guard, Dawn | shader statements | guards |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| IndirectOS ownership map, 1280×800 | 2,048,000 | 0 | 0 | 0 | 0 | 510 | 537 |
| life-calendar, 2 pointer states | 547,860 | 265,966 | 266,476 | 0 | 0 | 74 | 67 |
| candidate-gallery, 256 widths | 15,104 | 1,130 | 1,130 | 0 | 0 | 303 | 170 |
| candidate-gallery, 256×256 grid | 3,866,624 | 325,019 | 327,231 | 0 | 0 | 328 | 201 |
| SDF shapes, 2 pointer states | 1,612,800 | 42,851 | 45,241 | 0 | 0 | 762 | 787 |
| 12 random circuits, 256 instances each | 214,784 | 20,669 | 20,482 | 0 | 0 | 87-842 | 8-884 |

The ownership map is exact even without the guard because every product in it is an exact integer, so fusing changes nothing. The life calendar breaks badly without the guard (differences up to 687, i.e. wrong rows and columns) because its `round` steps are exactly the folded shape. The no-guard counts differ between the two stacks, e.g. 265,966 against 266,476 for the life calendar and 3,575 against 2,982 for random circuit 8. That fits the reordering probe: what the compiler regroups depends on the code around it, and wgpu and Dawn translate WGSL to Metal differently.

A first version of the unguarded emission had a bug of its own. Without the `max` wrapper it wrote no parentheses around a ReGLU row's left sum, so `(a + b) * gate` came out as `a + b * gate`. The CPU interpreter only caught the bug once the tests interpreted the unguarded shaders too, not only the guarded ones. Nine of the twelve random circuits have such rows (2 to 6 per circuit) and none of the five workloads does. After the fix, the random circuits' no-guard total dropped from 32,372 to 20,669 on wgpu and from 32,288 to 20,482 on Dawn, while every workload's no-guard count stayed the same. Guarded shaders were never affected.

With the guard, uploading the shared values, dispatching, and reading the outputs back took about 0.3 to 1.8 ms through Dawn for every workload, including the million-pixel map; the same work takes about 180 ms in generated JS on the CPU under Bun. The per-instance sources were uploaded once before these runs and aren't in those times. Uploading them (`writeBuffer`, an empty submit, then waiting on `onSubmittedWorkDone`) took 1.7 to 1.8 ms through Dawn for the press map's 8 MB of pixel coordinates, and 0.5 to 0.8 ms for the other workloads. Through Deno every run took about 15 ms regardless of size, which looks like polling latency in Deno's `mapAsync`. In the first runs, guarded shaders took 15 to 90 ms to compile. In the latest runs, the nine unguarded random-circuit shaders whose arithmetic changed with the fix took 28 to 132 ms to compile on wgpu, and every other shader compiled in 1 to 10 ms on wgpu and 1 to 13 ms on Dawn, which suggests that shaders seen in earlier runs came from caches.

### Correctness checks

- Generated JS matches the reference evaluator on every live wire of 60 random circuits whose contracts hold (gathers, argmax, first-active) over 960 source tables, of candidate-gallery, and of IndirectOS after an interaction (5,454 packed values). The same test adds 960 source tables with huge finite values: ±3e38 or ±1e30 in the open source cell, and ±1000, the ends of their declared range, in the bounded cells. 540 of these overflow to Infinity or NaN somewhere in the reference evaluation and are skipped; the other 420 match on every wire. Generated JS also stays bit-identical to the executor on circuits that break their own one-hot contracts, whose sources can hold Infinity.
- Over the 240-frame session, generated JS (with validation on) and the executor copy track the production machine bit for bit on all 201 source cells and all 348 distinct output wires (the root list has 429 entries, with repeats), every frame. Each press lands on the part the session names, according to the press map's float64 reference, and each event changes the state it should: window 0 ends at 254, 154 after the drag and at 620×400 after the resize, window 1's open flag goes to 0 and back to 1, Photos' maximized flag goes to 1 and back to 0, photo 5 gets focus, then photo 6, then photo 5 again, the focus clears, and window 1's minimized flag goes to 1.
- Both instance backends match the reference evaluator on every live wire of every instance of 40 random circuits, including per-instance gather slots. Each circuit runs 37 instances in blocks of 3, 7 or 16, checked block by block (861,582 values), and the requested outputs of all instances are checked after one run over every block (103,526 outputs). candidate-gallery matches the reference evaluator for 64 widths, and for every 31st viewport of the 256×256 width × height grid (2,116 viewports, 59 outputs each, both backends).
- Ownership map: 0 owner and 0 region mismatches against the float64 stack walk over 1,024,000 pixels for four session states, each taken after a step at 1280×800: the initial layout, window 1 closed, Photos maximized, and the end of the session (scratch script `check-workloads.ts`). The tests check the end state over a 320×200 grid.
- life-calendar: 0 mismatches in column count, row, column, filled, today, pill kinds and hover over 7 viewports × 41 pointer positions × 27,393 cells, with positions within 0.0002 px of the demo's float64 values. The row formula is exact for all 27,393 cells and all 140 column counts, replayed in FP32 arithmetic. Grid sizing matches the demo's column and row counts on all 197,232 viewports of phase one's sweep.
- SDF shapes: the frontmost shape bit matches the float64 reference on every pixel away from a 0.02 px band around edges. Colors are within 2.8/255 with 16 directions and within 0.17/255 with 64 directions, which confirms the difference comes from the polygon length.
- WGSL: literals round-trip the exact bits for 20,000 random float32 bit patterns over every finite exponent (2,022 of them subnormal), plus both zeros and a few hand-picked values. The emitted shaders, with and without the max guard, interpreted with strict f32 rounding, reproduce the CPU outputs for 25 random circuits and for the ownership map, life-calendar, candidate-gallery widths and SDF shapes.

### A runtime finding along the way

The builder's ranges don't track NaN. `Math.max(0, NaN)` is NaN, yet a relu of a wire with an unbounded range gets the range 0..Infinity, and a later product with a finite left side gets a finite range while holding NaN. Gather lowering trusts finite ranges to skip unselected products, so when a source cell holds Infinity, the executor reads the selected value while the reference's dense sum is NaN. `bun lab/ui-exploration/codegen/nan-range-case.ts` prints the first case and the chain of NaN wires with their declared ranges: it starts at `Infinity * max(0, -994)`, passes through a relu declared 0..Infinity, and reaches a product declared -5518495.5..5535051. Over 200 random circuits it finds 10 source tables where every one-hot group holds and the two evaluators still differ. The production demos can't reach it because their JavaScript validation rejects non-finite sources. I didn't change the runtime.

## What this shows about how far the approach goes

### What fit well

- Interpretation is about 90% of the executor's cost for IndirectOS, and the program shape translates mechanically into code. The same arithmetic as JavaScript statements evaluates a frame in about 3 µs instead of 30 µs, exact on every wire, with no change to the builder.
- The instance axis needed no new builder concepts. Which values are shared follows from which source cells are per-instance, the same way a shader separates uniforms from per-fragment values. The compiled program already had everything needed.
- Several UI tools became cheap once one circuit runs over many instances:
  - a map of what a press does at every pixel of IndirectOS, from the live source table, in about 2 ms on the GPU through Dawn once the pixel coordinates are uploaded;
  - a map of which candidate-gallery layout wins at 65,536 viewport sizes, in about 8 ms on the CPU, which shows every reflow boundary at once;
  - a 27,393-cell calendar whose per-cell logic is 63 rows.
- Shader habits turned into circuit reformulations that avoid missing operations. A per-cell hit test replaces floor division of the pointer. Floor division by a runtime integer becomes a product with a shared reciprocal plus a rounding step, exact because the quotient sits on a coarse grid. A fan of projections replaces the square root in a distance.
- Emitting WGSL was straightforward, and with the guard the GPU results matched the CPU bit for bit through two WebGPU implementations, including on circuits with gathers, selections and booleans.

### What got awkward

- Cold start works against generated code. The first frame costs about 5 ms and the first hundred frames are several times slower than the executor, so the speedup only shows after a warmup that a page's first seconds don't have. One large function never gets optimized at all in JavaScriptCore.
- The GPU compiler measured here doesn't keep per-operation FP32 rounding by default. Exactness needed a guard around nearly every operation, and the guard relies on the compiler not seeing through a runtime value. That held today, but no spec promises it, and only Apple's Metal compiler was tested.
- The batched interpreter was slower than generated code for most workloads. Visiting a row once per block only paid off when the per-instance part was tiny.
- The polygon length is an approximation: exact decisions away from edges, but colors differ from true Euclidean shading by a few units out of 255 at 16 directions.
- Getting outputs back to JavaScript has a fixed cost: about 0.3 to 0.7 ms through Dawn even for 256 instances, and 15 ms through Deno.
- The emitted shader text needs differential tests in every mode. The unguarded emission had an operator precedence bug that the tests missed while they only interpreted guarded shaders, and the bug inflated the no-guard GPU counts for the random circuits.
- Dawn's Node bindings crashed with a segmentation fault (exit 139) in two full runs of `gpu-headless.ts`, when the comparison loop allocated millions of small array views. Comparing whole tables avoided it; Deno never crashed.

### What stayed outside the circuit

- Drawing. The GPU path reads outputs back and JavaScript paints them into a canvas; a real renderer would feed the outputs to a fragment shader or instanced quads without reading them back.
- Per-pixel state across frames, e.g. the path tracer's accumulation buffers, wasn't attempted.
- life-calendar's tooltip text, `localStorage`, and the hover color hash stay in JavaScript.
- The WebGPU page ran in a browser only in the browser check below: one Chrome, one Apple GPU.

## Open questions and next steps

- Tiered execution: start with the executor, warm generated functions during idle time, then switch. That would keep the executor's cold behavior and the generated code's warm speed.
- Check the guard on other WebGPU backends (Dawn on D3D12 and Vulkan, Safari's implementation), and on other Metal compile settings. If a backend exposes strict math, the guard could be dropped there.
- Instance axis inside IndirectOS itself: windows, dock items, or thumbnails as instances of one per-item program instead of copied operations, with a reduction (frontmost, first active) across instances.
- Search and training in parallel: many candidate parameter sets or behavior variants as instances of one circuit, e.g. hundreds of spring settings evaluated over a gesture at once.
- A bounds-and-NaN-aware range propagation in `numeric-ui-core.ts`, so gather lowering stays sound when a source can hold Infinity.

## Browser check

2026-09-13, Chrome, served with `bun lab/ui-exploration/codegen/demo.html`.

- First check: the page didn't run. It threw "candidate gallery stage is missing" while its modules loaded, so no canvas was drawn, and no WebGPU comparison or probe result appeared. `demo-model.ts` and `workloads.ts` imported `candidate-gallery.ts` from the repo root, and `window-ownership.ts` and `indirect-os-machine.ts` imported `window-manager.ts`. Both root modules mount their own page at import time whenever `document` exists: `candidate-gallery.ts` looks for `#candidate-stage`, and `window-manager.ts` looks for `#desktop`. Headless runs have no `document`, so the tests never hit this.
- Fixed without changing the root modules: `candidate-gallery-copy.ts` and `window-manager-copy.ts` hold the same code without the mount at import time, and without the DOM renderers that only the mount uses. Every module in the folder now imports the copies, including the tests, `report.ts`, and `gpu-headless.ts` through `workloads.ts`. `root-copies.test.ts` adds 2 tests: each copy compiles to the same program as its root module, and the IndirectOS copy steps to bit-identical values over the 240-frame scripted session. `bun test lab/ui-exploration/codegen` (20 tests) and `bunx tsgo -p lab/ui-exploration/codegen` pass.
- Recheck: the page loads with no console errors, draws the SDF shapes, and runs the probes on the GPU. The tab was hidden, so I replaced `requestAnimationFrame` from the console with a scheduler that runs callbacks about every 16 ms, and a script switched between the workloads, the two backends and the guard setting.
- GPU compiler probes: without the guard, each multiply-add form gave 0 strict results of 8, all equal to the fused value, and with the max guard 8 of 8 were strict. The boolean atom gave 0 of 2 strict without the guard and 2 of 2 with it. Sums with a different written order were strict (2 of 2) in every form. These are the answers wgpu and Dawn gave headlessly.
- GPU outputs that differ from generated JS in any bit, at the page's sizes, with one pointer state each:

| workload in the page | outputs compared | max guard | no guard | shader compile, guard / no guard | dispatch and readback with the guard |
| --- | ---: | ---: | ---: | --- | --- |
| SDF shapes, 560×360 | 806,400 | 0 | 23,883 (largest difference 1.65e-3) | 86 / 54 ms | 1.5 to 2.4 ms |
| IndirectOS press map, 640×400 | 512,000 | 0 | 0 | 63 / 47 ms | 2.2 ms |
| life-calendar cells | 273,930 | 0 | 132,879 (largest difference 341) | 24 / 22 ms | 0.7 ms |
| candidate-gallery layout map, 256×256 | 3,866,624 | 0 | 325,019 (largest difference 2.44e-4) | 49 / 40 ms | 6.5 to 7.8 ms |

- With the guard, Chrome's GPU results match generated JS bit for bit on all four workloads. Without it, the press map is still exact, as headless. The layout map's no-guard count equals the wgpu count in the WGSL table above (325,019), not Dawn under Node's (327,231). Without the guard, the life calendar's GPU outputs lose the hover: the pointer label read "no cell under the pointer", where generated JS found day 11,237.
- Generated JS backend: every workload draws its canvas, e.g. 414 distinct colors for the shapes and 324 for the layout map, and the pointer label names what's under the pointer, e.g. "window 1, content" on the press map and "1260×1146: Cinema (score 1.000)" on the layout map. One CPU run of the shared part and every instance took 378 to 454 ms for the shapes, 673 to 1,283 ms for the press map, 12 to 101 ms for the life calendar and 78 to 301 ms for the layout map, the first run of each being the slowest. That is several times Bun's numbers above, e.g. 72 ms for the same 560×360 shapes.
- Not checked: how the page behaves at the browser's own frame pacing, since the tab was hidden, and any other GPU or browser.
