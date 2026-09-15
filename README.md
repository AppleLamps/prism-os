# Indirect

Indirect tests whether an interactive UI can compile into one fixed numeric program. JavaScript records browser inputs, runs the program, and projects its outputs to the DOM.

```sh
bun start
bun run start:candidates
bun run start:hard-attend
bun run start:learning
bun run start:reusable
bun run test
bun check
```

IndirectOS has four fixed window slots. The source table holds viewport facts, input latches, window state, stacking, spring state, Photos state, and app constants. One compiled circuit handles:

- focus, stacking, dragging, resizing, and window controls
- dock transitions and fixed-step springs
- the Photos grid, lightbox, navigation, and spring-animated thumbnail strip
- numeric visibility used to attach and remove photo nodes

Photos is authored separately, then inlined before the system compiles. The browser still runs one source table, one circuit, and one render loop.

The candidate gallery is a separate experiment. Cinema, Contact, and Story all run against the same viewport. Each scores its smallest normalized hero, cell, or thumbnail; a balanced argmax tournament chooses the projected geometry.

The learning gallery trains a small geometry network rather than choosing among authored layouts. Its 244 coefficients define two shared ReGLU layers that map fixed slot positions to rectangle geometry. Training pairs the unlabeled target and output sets, then backpropagates coordinate and soft shared-edge losses. Small alignment mistakes snap toward repeated edges, while deliberate offsets and layouts absent from the product source remain learnable.

## Runtime

The runtime has three operations, plus an index read instruction:

```txt
affine  = weighted sum plus offset
reglu   = one affine value times ReLU of another
boolean = a score in 0..1 rounded to an exact bit
index   = the value at floor(index) in a table of earlier values, copied without rounding
```

Macros such as multiply, min, max, springs, and winner selection expand into those operations before compilation. Every arithmetic step uses FP32.

Independent instructions share layers. Each layer gathers the values it reads, runs one sparse affine projection, applies gather reads, index reads, ReGLU gates and Boolean rounding, then appends its outputs.

The execution backend is currently serial JavaScript, not GPU code. Multiplication and selection preserve their meaning for differentiation, and `roundAffine` preserves required FP32 rounding points. See [execution semantics](execution-model.md).

Current results, domains, and limitations are recorded in [lab/status.md](lab/status.md). `bun lab/runtime-cost/report.ts` reports current program sizes and CPU costs, including an opt-in evaluator that reuses buffers and returns only requested outputs. Old program-size and timing tables should not be applied to a changed graph.

## Files

- `numeric-ui-core.ts`: circuit construction, compilation, and execution
- `host-timing.ts`: frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript
- `index-read.test.ts`, `comparison.test.ts`, `spring-matrix.test.ts`: tests for index reads, exact comparisons, and springs whose matrix the host writes
- `window-manager.ts`: IndirectOS circuit and DOM projection
- `photo-gallery.ts`: Photos circuit and DOM projection
- `candidate-gallery.ts`: three-layout runtime search experiment
- `candidate-gallery.html`: standalone candidate gallery
- `trainable-geometry.ts`: learned affine/ReGLU geometry network and optimizer
- `learned-gallery.ts`: rectangle fitting, backpropagation, and DOM projection
- `learned-gallery.html`: standalone learning gallery
- `hard-attend.ts`, `hard-attend.html`: interactive hard-attend walkthrough
- `execution-model.md`: exact instruction and layer semantics
- `macro-ranges.md`: FP32 magnitude preconditions for the macro library
- `expressions.md`: constructions that replace one familiar expression, e.g. exact decision bits for `a >= b`
- `patterns.md`: constructions that replace a familiar loop, e.g. a balanced tree instead of `findIndex` over overlapping click targets
- `behavior-choices.md`: choices that change what the user sees, e.g. hit-testing where elements are going instead of where they're drawn
- `research-sweep.md`: landed and parked experiments, and supersession records
- `ideas.md`: unexplored directions
- `todo.md`: open tasks, e.g. revisiting hardAttend
- `exp/`: early experiments, kept where still unique (supersessions in `research-sweep.md`)
- `lab/`: experiment folders, each with a README full of measurements, and the briefs in `lab/briefs/`; `lab/status.md` summarizes current results. Demos: `bun lab/generative-fields/demo.html`, `bun lab/event-window/demo.html` and `bun run start:reusable`

Tests compare the literal and compiled FP32 evaluators, including seeded random circuits. Product tests cover window interactions, stacking, springs, tiny viewports, Photos focus, candidate layout search, overlapping controls, and DOM culling.

The TODO list below is retained from the earlier discussion. Its finite-range/gather item has since been completed; current status is in `lab/status.md`.

## TODO

do not change this before asking the user

- Revisit dynamic division only when a real UI needs it.
- Retry layer scheduling after the circuit shape changes; Percepta's mixed-integer formulation (scheduling plus residual-slot reuse) is the reference approach.
- Declare finite ranges in the production builders so recognized one-hot reads lower to gathers (currently zero engage, because geometry is declared 0..Infinity).
