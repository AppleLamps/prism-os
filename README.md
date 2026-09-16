# Indirect

Indirect tests whether an interactive UI can compile into one fixed numeric program. JavaScript records browser inputs, runs the program, and projects its outputs to the DOM.

```sh
bun start
bun run start:candidates
bun run start:hard-attend
bun run start:learning
bun run start:reusable
bun lab/ui-exploration/serve-demos.ts
bun run test
bun run check
```

IndirectOS has four fixed window slots. The source table holds viewport facts, input latches, window state, stacking, spring state, Photos state, and app constants. One compiled circuit handles:

- focus, stacking, dragging, resizing, and window controls
- dock transitions, and springs that run fixed 4 ms steps up to each event's timestamp, from a step matrix that JavaScript writes into cells
- the Photos grid, lightbox, navigation, and spring-animated thumbnail strip
- numeric visibility used to attach and remove photo nodes

Photos is authored separately, then inlined before the system compiles. The browser still runs one source table, one circuit, and one render loop.

The candidate gallery is a separate experiment. Cinema, Contact, and Story all run against the same viewport. Each scores its smallest normalized hero, cell, or thumbnail; a balanced argmax tournament chooses the projected geometry.

The learning gallery trains a small geometry network rather than choosing among authored layouts. Its 244 coefficients define two shared ReGLU layers that map fixed slot positions to rectangle geometry. Training pairs the unlabeled target and output sets, then backpropagates coordinate and soft shared-edge losses. Small alignment mistakes snap toward repeated edges, while deliberate offsets and layouts absent from the product source remain learnable.

The hard-attend walkthrough reads one item out of several. Move the query slider to compare a one-hot gather, a direct gather and a softmax gather, and drag the sharpness slider to bring the softmax result toward the exact one.

`bun lab/ui-exploration/serve-demos.ts` serves every demo in the repo, including the lab and exploration prototypes, from one index page at http://127.0.0.1:4321/.

## How a program is written

A program is a list of instructions of four kinds, and every arithmetic step uses FP32:

```txt
affine  = weighted sum plus offset
reglu   = one affine value times ReLU of another
boolean = a score in 0..1 rounded to an exact bit
index   = the value at floor(index) in a table of earlier values, copied without rounding
```

Builder functions, also called macros, e.g. `emitMinimum` (3 operations) or `emitFirstActive` (a tree over n candidates), expand into instructions before compilation, so they aren't a level of their own. The docs group what you build from instructions by the size of the familiar code it replaces:

- [expressions.md](expressions.md): one expression, e.g. `a >= b`, `Math.min(a, b)` or `table[index]`, where the hard part is an exact FP32 result.
- [patterns.md](patterns.md): a loop, e.g. `findIndex` or `items.sort(compare)`. The program runs every operation on every frame and can't stop early, so a loop becomes a count, a tree, a table, or the same work on every item.
- [behavior-choices.md](behavior-choices.md): a choice that changes what the user sees, e.g. hit-testing where elements are going instead of where they're drawn, to shorten dependency chains, make stored state independent of the frame rate, or keep each frame's work under a fixed maximum.
- Contracts: [execution-model.md](execution-model.md) defines the instructions, and the contracts of the builder functions that other docs depend on, e.g. index reads, comparisons, grids, rounding points, springs and time. [macro-ranges.md](macro-ranges.md) gives each builder function's magnitude limits.

Independent instructions share a layer, and today's executor is serial JavaScript on the CPU ([execution-model.md](execution-model.md#compilation)). `bun lab/runtime-cost/report.ts` reports current program sizes and CPU costs; old size and timing tables don't apply to a changed program.

Reading list: start with this README, expressions.md, patterns.md, behavior-choices.md, and [lab/status.md](lab/status.md) for current results, known issues and open decisions. Implementers and agents continue with execution-model.md, macro-ranges.md, [the guide](lab/ui-exploration/guide/README.md), and the lab READMEs.

## Files

- `numeric-ui-core.ts`: circuit construction, compilation, and execution
- `host-timing.ts`: frame timing, spring step counts and matrices, and the evaluations between frames, computed in host JavaScript
- `index-read.test.ts`, `comparison.test.ts`, `spring-matrix.test.ts`: tests for index reads, exact comparisons, and springs whose matrix the host writes
- `index.html`, `window-manager.ts`: IndirectOS page, circuit and DOM projection
- `photo-gallery.ts`: Photos circuit and DOM projection
- `candidate-gallery.ts`, `candidate-gallery.html`: three-layout runtime search experiment
- `trainable-geometry.ts`: learned affine/ReGLU geometry network and optimizer
- `learned-gallery.ts`, `learned-gallery.html`: rectangle fitting, backpropagation, and DOM projection
- `hard-attend.ts`, `hard-attend.html`: interactive hard-attend walkthrough
- `execution-model.md`: exact instruction and layer semantics, and the contracts of builder functions
- `macro-ranges.md`: FP32 magnitude preconditions for the macro library
- `expressions.md`: constructions that replace one familiar expression, e.g. exact decision bits for `a >= b`
- `patterns.md`: constructions that replace a familiar loop, e.g. a balanced tree instead of `findIndex` over overlapping click targets
- `behavior-choices.md`: choices that change what the user sees, e.g. hit-testing where elements are going instead of where they're drawn
- `research-sweep.md`: history: landed changes, lab round one, superseded experiments
- `ideas.md`: unexplored directions
- `todo.md`: open tasks, e.g. revisiting hardAttend
- `exp/`: early experiments, kept where still unique (supersessions in `research-sweep.md`)
- `lab/`: experiments, each with a README full of measurements
  - `status.md`: current results, known issues, open decisions, and parked and deferred work
  - `reassessment-2026-09-03.md`: the September 3, 2026 review of the July results
  - `cascade-argmax/`: exact argmax through a sign cascade, trained through soft comparisons, then hardened
  - `data-adapter/`: exhaustive program search for reading a rectangle by id
  - `event-window/`: dragging, focus and click-versus-drag as a function of latched events, with trained behavior parameters; demo `bun lab/event-window/demo.html`
  - `gather-lowering/`: declared one-hot groups, and masked sums compiled into gathers
  - `generative-fields/`: one layout circuit driven by input fields, and repair of invalid layouts; demo `bun lab/generative-fields/demo.html`
  - `learned-interpreter/`: learning the two instructions of a tiny interpreter
  - `reusable-layout/`: one learned rule that proposes each photo's width; demo `bun run start:reusable`
  - `runtime-cost/`: CPU costs of the evaluators, including one that reuses buffers
  - `trace-compiler/`: a numeric subset of TypeScript compiled into circuits
  - `user-effort/`: predicting task duration, then choosing a layout
  - `ui-exploration/`: the September 12-14, 2026 exploration of how far circuit UI goes, with 24 prototypes, notes and `serve-demos.ts`
  - `ui-exploration/guide/`: explanations that start from the familiar JavaScript, the long forms of the patterns, and runnable examples checked against plain JavaScript
  - `briefs/`: the July 2026 briefs, historical

Tests compare the literal and compiled FP32 evaluators, including seeded random circuits. Product tests cover window interactions, stacking, springs, tiny viewports, Photos focus, candidate layout search, overlapping controls, and DOM culling.

The TODO list below is retained from the earlier discussion. Its finite-range/gather item has since been completed; current status is in `lab/status.md`.

## TODO

do not change this before asking the user

- Revisit dynamic division only when a real UI needs it.
- Retry layer scheduling after the circuit shape changes; Percepta's mixed-integer formulation (scheduling plus residual-slot reuse) is the reference approach.
- Declare finite ranges in the production builders so recognized one-hot reads lower to gathers (currently zero engage, because geometry is declared 0..Infinity).
